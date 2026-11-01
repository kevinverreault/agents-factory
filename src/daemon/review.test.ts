// Seam 1: reviewing a root task (ADR 0011). Only the operator closes the
// loop: Request changes resumes the session on their comments, and Mark done
// finishes the task once its branch is on the base branch, or when they say
// to finish anyway. A Done root's transcripts are archived, then its
// worktree and local task branch removed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

// A factory with T1 launched from a one-stage AFK preset, its run R1 done
// and the root In review.
async function inReview(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
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
  factory.executor.report('R1', { type: 'runCompleted' });
  await tui.until((state) => state.tasks.T1?.label === 'In review');
  return { factory, operator, tui };
}

describe('Request changes', () => {
  test('queues a run that resumes the session on the review comments, and its completion puts the root back In review', async () => {
    const { factory, operator, tui } = await inReview();

    expect(await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Put the button in the header, not the footer.' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    const [first, changes] = factory.executor.started;
    expect(changes).toMatchObject({ runId: 'R2', mode: 'AFK', sessionId: first!.sessionId, resumesSession: true });
    expect(changes!.firstMessage).toContain('Put the button in the header, not the footer.');
    expect(tui.state().attentionQueue).toEqual([]);

    factory.executor.report('R2', { type: 'runCompleted' });
    const reviewed = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewed.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.executor.started).toHaveLength(2);
  });

  test('needs the review comments, and only a root In review takes it', async () => {
    const { factory, operator, tui } = await inReview();

    expect(await operator.send({ type: 'requestChanges', taskId: 'T1', comments: '  ' })).toEqual({
      ok: false,
      reason: 'Request changes needs your review comments: say what to change.',
    });
    await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Rename it Sign out.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'And bold.' })).toEqual({ ok: false, reason: 'T1 is not in review.' });
    expect(factory.executor.started).toHaveLength(2);
  });
});

const clone = resolve('/clones/widgets');
const branch = 'factory/T1-add-a-logout-button';

// The run committed its work on the task branch.
function committed(factory: TestFactory, tui: Watched): void {
  const { worktree } = tui.state().tasks.T1!;
  factory.git.editFile(worktree!, 'src/logout.ts');
  factory.git.commitAll(worktree!);
}

describe('Mark done', () => {
  test('finishes a root whose branch is merged into the base branch on origin, fetched afresh', async () => {
    const { factory, operator, tui } = await inReview();
    committed(factory, tui);
    factory.git.merge(clone, branch, 'main');

    expect(await operator.send({ type: 'markDone', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(tui.state().attentionQueue).toEqual([]);
  });

  test('on an unmerged branch asks “Finish anyway?”, and finishes once the operator confirms', async () => {
    const { factory, operator, tui } = await inReview();
    committed(factory, tui);

    const asked = await operator.send({ type: 'markDone', taskId: 'T1' });

    expect(asked).toEqual({
      ok: false,
      reason: `Not merged into main: ${branch}’s tip isn’t on origin/main. Finish anyway?`,
      confirm: { type: 'markDone', taskId: 'T1', anyway: true },
    });
    expect(tui.state().tasks.T1?.label).toBe('In review');
    expect(await operator.send({ type: 'markDone', taskId: 'T1', anyway: true })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.label === 'Done');
  });

  test('asks “Finish anyway?” too when origin can’t be reached to check', async () => {
    const { factory, operator } = await inReview();
    factory.git.cutOffOrigin(clone, 'fatal: unable to access origin');

    expect(await operator.send({ type: 'markDone', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'Couldn’t check whether T1 is merged: couldn’t fetch main from the origin of acme/widgets (fatal: unable to access origin). Finish anyway?',
      confirm: { type: 'markDone', taskId: 'T1', anyway: true },
    });
  });
});

describe('at Done', () => {
  test('the task’s transcripts are archived, then its worktree removed and its local branch deleted, and the branch checks out again from origin', async () => {
    const { factory, operator, tui } = await inReview();
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'The logout button is in.' });
    committed(factory, tui);
    factory.git.push(clone, branch);
    const sessionId = factory.executor.started[0]!.sessionId;

    await operator.send({ type: 'markDone', taskId: 'T1', anyway: true });

    const done = await tui.until((state) => state.tasks.T1?.transcripts !== null);
    const archive = join(factory.paths.transcriptsRoot, 'T1');
    expect(done.tasks.T1).toMatchObject({ label: 'Done', transcripts: archive, cleanup: null });
    expect(factory.executor.archived).toEqual([{ sessionId, dir: archive, events: 2 }]);
    expect(await factory.git.worktrees(clone)).toEqual([]);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
    await factory.git.fetch(clone, branch);
    await factory.git.addWorktree(clone, { path: done.tasks.T1!.worktree!, branch, startPoint: `origin/${branch}` });
  });

  test('a Done task’s conversation still replays, read from its archive', async () => {
    const { factory, operator, tui } = await inReview();
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'The logout button is in.' });
    await operator.send({ type: 'markDone', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.transcripts !== null);

    const events: ConversationEvent[] = [];
    operator.converse('R1', (event) => events.push(event));

    await expect.poll(() => events.map((event) => event.type === 'message' && event.text)).toEqual(['/factory:implement Add a logout button.', 'The logout button is in.']);
    expect(factory.executor.historyReads.at(-1)).toMatchObject({ archive: join(factory.paths.transcriptsRoot, 'T1') });
  });

  test('a failed archive removes nothing, and the cleanup finishes once the daemon starts again', async () => {
    const { factory, operator, tui } = await inReview();
    factory.executor.failArchive('EACCES: permission denied');

    await operator.send({ type: 'markDone', taskId: 'T1' });

    const stuck = await tui.until((state) => !!state.tasks.T1?.cleanup?.problem);
    expect(stuck.tasks.T1).toMatchObject({ label: 'Done', transcripts: null });
    expect(stuck.tasks.T1?.cleanup?.problem).toBe('The factory couldn’t archive T1’s transcripts, so it removed nothing yet: EACCES: permission denied');
    expect(await factory.git.worktrees(clone)).toHaveLength(1);

    factory.executor.failArchive(null);
    await factory.restart();
    const later = watch(await factory.attach());
    await later.until((state) => state.tasks.T1?.transcripts !== null && state.tasks.T1?.cleanup === null);
    expect(await factory.git.worktrees(clone)).toEqual([]);
  });
});
