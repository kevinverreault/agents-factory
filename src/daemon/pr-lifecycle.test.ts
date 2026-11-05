// Seam 1: the draft PR drives the root's end (ADR 0011). While a root is In
// review with a PR, the daemon reads the PR's state as the App when a TUI
// attaches and every 15 minutes, the factory's only poll. A merged PR makes
// the root Done, and its cleanup deletes the remote task branch. A PR closed
// unmerged raises a pr-closed-unmerged entry offering Cancel task or Reopen
// PR, never cancelling on its own. Cancelling a root closes its draft PR and
// deletes the remote branch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const clone = resolve('/clones/widgets');
const branch = 'factory/T1-add-a-logout-button';
const MINUTE = 60_000;

// A factory with T1, an L1 root In review whose draft PR #101 the factory
// opened from its pushed task branch.
async function withDraftPr(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(
    join(factory.paths.presetsDir, 'unattended.preset.yaml'),
    'stages:\n  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", exit: run-completed }\n',
  );
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: 'Add a logout button.' });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  const worktree = tui.state().tasks.T1!.worktree!;
  factory.git.editFile(worktree, 'src/logout.ts', 'export {};\n');
  factory.git.commitAll(worktree);
  factory.executor.report('R1', { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.label === 'In review');
  await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });
  await tui.until((state) => state.tasks.T1?.pr !== null);
  return { factory, operator, tui };
}

describe('a merged PR', () => {
  test('makes its root Done when a TUI attaches, and the cleanup deletes the remote task branch as the App', async () => {
    const { factory } = await withDraftPr();
    factory.github.merge(101);

    const tui = watch(await factory.attach());

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(done.attentionQueue).toEqual([]);
    expect(factory.git.originTip(clone, branch)).toBeNull();
    expect(factory.git.branchTip(clone, branch)).toBeNull();
    expect(factory.github.branchDeletes).toEqual([
      { repo: 'acme/widgets', branch, token: expect.objectContaining({ permissions: { contents: 'write', metadata: 'read' } }) },
    ]);
  });

  test('is found by the poll every 15 minutes, with no TUI attaching', async () => {
    const { factory, operator, tui } = await withDraftPr();
    factory.github.merge(101);

    factory.clock.advance(14 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(tui.state().tasks.T1?.label).toBe('In review');

    factory.clock.advance(MINUTE);

    await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.git.originTip(clone, branch)).toBeNull();
  });
});

describe('a PR closed without merging', () => {
  test('raises a pr-closed-unmerged entry, never cancelling the root, which stays In review', async () => {
    const { factory } = await withDraftPr();
    factory.github.closeUnmerged(101);

    const tui = watch(await factory.attach());

    const asked = await tui.until((state) => state.attentionQueue.length === 2);
    expect(asked.attentionQueue).toEqual([
      expect.objectContaining({
        kind: 'attention',
        taskId: 'T1',
        attention: 'pr-closed-unmerged',
        reason: 'PR #101 of T1 was closed without merging. Cancel the task, or reopen the PR.',
      }),
      { kind: 'review', taskId: 'T1' },
    ]);
    expect(asked.tasks.T1?.label).toBe('In review');
    expect(factory.git.originTip(clone, branch)).not.toBeNull();

    // Polled again, it asks once.
    const again = await factory.attach();
    watch(again);
    await again.send({ type: 'daemon.status' });
    expect(tui.state().attentionQueue).toHaveLength(2);
  });

  test('Reopen PR reopens it on GitHub as the App, and the entry goes', async () => {
    const { factory, operator } = await withDraftPr();
    factory.github.closeUnmerged(101);
    const tui = watch(await factory.attach());
    await tui.until((state) => state.attentionQueue.length === 2);

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'T1’s PR was closed without merging: cancel the task, or reopen its PR.',
    });
    expect(await operator.send({ type: 'reopenPr', taskId: 'T1' })).toEqual({ ok: true });

    const reopened = await tui.until((state) => state.attentionQueue.length === 1);
    expect(reopened.tasks.T1?.label).toBe('In review');
    expect(factory.github.prState(101).state).toBe('open');
    expect(factory.github.prWrites).toEqual([
      { action: 'reopen', repo: 'acme/widgets', number: 101, token: expect.objectContaining({ permissions: { pull_requests: 'write', metadata: 'read' } }) },
    ]);
    expect(await operator.send({ type: 'reopenPr', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1’s PR isn’t closed unmerged.' });
  });

  test('a refused Reopen PR says why, and the entry stays', async () => {
    const { factory, operator } = await withDraftPr();
    factory.github.closeUnmerged(101);
    const tui = watch(await factory.attach());
    await tui.until((state) => state.attentionQueue.length === 2);
    factory.github.unreachable('GitHub couldn’t be reached: ECONNRESET');

    expect(await operator.send({ type: 'reopenPr', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'The factory couldn’t reopen PR #101 on GitHub as its App: GitHub couldn’t be reached: ECONNRESET',
    });
    expect(tui.state().attentionQueue).toHaveLength(2);
  });

  test('reopened on GitHub, the entry goes at the next poll', async () => {
    const { factory } = await withDraftPr();
    factory.github.closeUnmerged(101);
    const tui = watch(await factory.attach());
    await tui.until((state) => state.attentionQueue.length === 2);

    factory.github.reopen(101);
    watch(await factory.attach());

    await tui.until((state) => state.attentionQueue.length === 1);
  });

  test('Cancel task cancels the root and deletes its remote branch, leaving the closed PR as it is', async () => {
    const { factory, operator } = await withDraftPr();
    factory.github.closeUnmerged(101);
    const tui = watch(await factory.attach());
    await tui.until((state) => state.attentionQueue.length === 2);

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    const cancelled = await tui.until((state) => state.tasks.T1?.label === 'Cancelled' && state.tasks.T1.cleanup === null);
    expect(cancelled.attentionQueue).toEqual([]);
    expect(factory.git.originTip(clone, branch)).toBeNull();
    expect(factory.github.prState(101)).toEqual({ state: 'closed', comments: [] });
  });
});

describe('cancelling a root with a draft PR', () => {
  test('closes the PR with a comment, then deletes the remote task branch, both as the App', async () => {
    const { factory, operator, tui } = await withDraftPr();

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Cancelled' && state.tasks.T1.cleanup === null);
    expect(factory.github.prState(101)).toEqual({ state: 'closed', comments: ['Closed: the agents factory’s task T1 (Add a logout button.) was cancelled.'] });
    expect(factory.github.prWrites).toEqual([
      { action: 'close', repo: 'acme/widgets', number: 101, token: expect.objectContaining({ permissions: { pull_requests: 'write', metadata: 'read' } }) },
    ]);
    expect(factory.git.originTip(clone, branch)).toBeNull();
  });

  test('that GitHub refuses leaves the cleanup to the next daemon, which finishes it', async () => {
    const { factory, operator, tui } = await withDraftPr();
    factory.github.unreachable('GitHub couldn’t be reached: ECONNRESET');

    await operator.send({ type: 'cancel', taskId: 'T1' });

    const failed = await tui.until((state) => !!state.tasks.T1?.cleanup?.problem);
    expect(failed.tasks.T1?.cleanup?.problem).toBe(
      'The factory couldn’t close PR #101 and delete factory/T1-add-a-logout-button on GitHub as its App: GitHub couldn’t be reached: ECONNRESET',
    );
    expect(factory.git.originTip(clone, branch)).not.toBeNull();

    factory.github.unreachable(null);
    await factory.restart();

    const after = watch(await factory.attach());
    await after.until((state) => state.tasks.T1?.cleanup === null);
    expect(factory.github.prState(101).state).toBe('closed');
    expect(factory.git.originTip(clone, branch)).toBeNull();
  });
});

describe('cancelling a root whose draft PR couldn’t be opened', () => {
  test('deletes the task branch the factory pushed', async () => {
    const { factory, operator, tui } = await withDraftPr();
    // A second root, pushed but with no PR: GitHub refused to open it.
    await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' });
    await tui.until((state) => state.tasks.T1?.cleanup === null);
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: 'Add a footer.' });
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    const worktree = tui.state().tasks.T2!.worktree!;
    factory.git.editFile(worktree, 'src/footer.ts', 'export {};\n');
    factory.git.commitAll(worktree);
    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T2?.label === 'In review');
    factory.github.failPullRequests('GitHub couldn’t be reached: ECONNRESET');
    await operator.send({ type: 'pushAndOpenPr', taskId: 'T2' });
    await tui.until((state) => state.attentionQueue.some((item) => item.kind === 'attention' && item.taskId === 'T2'));
    const footer = 'factory/T2-add-a-footer';
    expect(factory.git.originTip(clone, footer)).not.toBeNull();

    await operator.send({ type: 'cancel', taskId: 'T2', branch: 'discard' });

    await tui.until((state) => state.tasks.T2?.label === 'Cancelled' && state.tasks.T2.cleanup === null);
    expect(factory.git.originTip(clone, footer)).toBeNull();
  });
});

describe('Mark done on a root with a PR', () => {
  test('deletes its remote task branch too', async () => {
    const { factory, operator, tui } = await withDraftPr();

    expect(await operator.send({ type: 'markDone', taskId: 'T1', anyway: true })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.git.originTip(clone, branch)).toBeNull();
    expect(factory.github.prState(101).state).toBe('open');
  });
});
