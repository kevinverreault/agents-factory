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

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with T1, an L1 root In review whose draft PR #101 the factory
// opened from its pushed task branch.
async function withDraftPr(): Promise<Factory> {
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
  const launched = { factory, operator, tui };
  await inReview(launched, 'Add a logout button.', 'T1', 'R1');
  await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });
  await tui.until((state) => state.tasks.T1?.pr !== null);
  return launched;
}

// Launches `prompt` as the root `taskId`, whose build run `runId` commits a
// file and completes, putting it In review.
async function inReview({ factory, operator, tui }: Factory, prompt: string, taskId: string, runId: string): Promise<void> {
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks[taskId]?.liveRunId === runId);
  const worktree = tui.state().tasks[taskId]!.worktree!;
  factory.git.editFile(worktree, `src/${taskId}.ts`, 'export {};\n');
  factory.git.commitAll(worktree);
  factory.executor.report(runId, { type: 'runCompleted' });
  await tui.until((state) => state.tasks[taskId]?.label === 'In review');
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

    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' })).toEqual({ ok: true });

    const cancelled = await tui.until((state) => state.tasks.T1?.label === 'Cancelled' && state.tasks.T1.cleanup === null);
    expect(cancelled.attentionQueue).toEqual([]);
    expect(factory.git.originTip(clone, branch)).toBeNull();
    expect(factory.github.prState(101)).toEqual({ state: 'closed', comments: [] });
  });
});

describe('cancelling a root with a draft PR', () => {
  test('closes the PR with a comment, then deletes the remote task branch, both as the App', async () => {
    const { factory, operator, tui } = await withDraftPr();

    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' })).toEqual({ ok: true });

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

    await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' });

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
    const launched = await withDraftPr();
    const { factory, operator, tui } = launched;
    // A second root, pushed but with no PR: GitHub refused to open it.
    await inReview(launched, 'Add a footer.', 'T2', 'R2');
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

describe('cancelling a published root whose work isn’t on the base branch', () => {
  test('asks to keep the branch or discard the work: its remote copy goes with the cancel', async () => {
    const { operator } = await withDraftPr();

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({
      ok: false,
      reason: `${branch} has 1 commit that exists nowhere else once its branch on GitHub is deleted.`,
      choose: [
        { label: 'Keep branch', command: { type: 'cancel', taskId: 'T1', branch: 'keep' } },
        { label: 'Discard work', command: { type: 'cancel', taskId: 'T1', branch: 'discard' } },
      ],
    });
  });

  test('Keep branch keeps the local branch, while the remote one goes', async () => {
    const { factory, operator, tui } = await withDraftPr();

    await operator.send({ type: 'cancel', taskId: 'T1', branch: 'keep' });

    await tui.until((state) => state.tasks.T1?.label === 'Cancelled' && state.tasks.T1.cleanup === null);
    expect(factory.git.branchTip(clone, branch)).not.toBeNull();
    expect(factory.git.originTip(clone, branch)).toBeNull();
  });
});

describe('Mark done on a root with a PR', () => {
  test('once its branch is merged, deletes its remote task branch too', async () => {
    const { factory, operator, tui } = await withDraftPr();
    factory.git.mergeIntoOrigin(clone, branch, 'main');

    expect(await operator.send({ type: 'markDone', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.git.originTip(clone, branch)).toBeNull();
  });

  test('finished anyway, unmerged, keeps its remote task branch: the work may still be wanted', async () => {
    const { factory, operator, tui } = await withDraftPr();

    expect(await operator.send({ type: 'markDone', taskId: 'T1', anyway: true })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.git.originTip(clone, branch)).not.toBeNull();
    expect(factory.github.branchDeletes).toEqual([]);
  });
});

describe('the 15-minute poll', () => {
  test('keeps the daemon up with no TUI attached while a root waits on its PR', async () => {
    const { factory, operator } = await withDraftPr();
    operator.close();
    const probe = await factory.attach();
    await expect.poll(async () => ((await probe.send({ type: 'daemon.status' })) as { value: { attachedTuis: number } }).value.attachedTuis).toBe(0);
    probe.close();
    factory.github.merge(101);

    factory.clock.advance(15 * MINUTE);

    await expect.poll(() => factory.git.originTip(clone, branch)).toBeNull();
  });
});

describe('a PR closed while a push to it failed', () => {
  test('raises the pr-closed-unmerged entry in place of the failed push’s', async () => {
    const { factory, operator, tui } = await withDraftPr();
    factory.github.unreachable('GitHub couldn’t be reached: ECONNRESET');
    await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' });
    await tui.until((state) => state.attentionQueue.some((item) => item.kind === 'attention' && item.attention === 'github-write'));
    factory.github.unreachable(null);
    factory.github.closeUnmerged(101);

    watch(await factory.attach());

    const asked = await tui.until((state) => state.attentionQueue.some((item) => item.kind === 'attention' && item.attention === 'pr-closed-unmerged'));
    expect(asked.attentionQueue).toEqual([expect.objectContaining({ attention: 'pr-closed-unmerged' }), { kind: 'review', taskId: 'T1' }]);
    expect(asked.tasks.T1).toMatchObject({ label: 'In review', publishing: null });
  });
});

describe('Reopen PR on a PR whose branch GitHub no longer has', () => {
  test('says why it can’t, and the entry stays', async () => {
    const { factory, operator } = await withDraftPr();
    factory.github.closeUnmerged(101);
    factory.git.deleteOnOrigin('acme/widgets', branch);
    const tui = watch(await factory.attach());
    await tui.until((state) => state.attentionQueue.length === 2);

    expect(await operator.send({ type: 'reopenPr', taskId: 'T1' })).toEqual({
      ok: false,
      reason: `The factory couldn’t reopen PR #101 on GitHub as its App: ${branch} is gone from GitHub, so #101 can’t be reopened. Push it again first, or cancel the task.`,
    });
    expect(tui.state().attentionQueue).toHaveLength(2);
  });
});
