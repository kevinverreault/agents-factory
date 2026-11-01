// Seam 1: cancelling a task (ADR 0011). Cancel means everything stops: the
// task's live run ends cancelled and its open request closes. Its
// transcripts are archived, then its worktree removed, and its local task
// branch with it, unless the operator keeps the branch. The operator is asked
// Keep branch or Discard work only when the branch holds commits found
// nowhere else.
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

// A factory with T1 launched from a one-stage AFK preset, its run R1 live.
async function running(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
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
  return { factory, operator, tui };
}

// The run committed work on the task branch.
function committed(factory: TestFactory, tui: Watched, path = 'src/logout.ts'): void {
  const { worktree } = tui.state().tasks.T1!;
  factory.git.editFile(worktree!, path);
  factory.git.commitAll(worktree!);
}

describe('cancelling a task', () => {
  test('with no commits of its own, ends its live run cancelled, then archives its transcripts and removes its worktree and branch without asking', async () => {
    const { factory, operator, tui } = await running();
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Starting on the button.' });
    const sessionId = factory.executor.started[0]!.sessionId;

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    const cancelled = await tui.until((state) => state.tasks.T1?.transcripts !== null);
    const archive = join(factory.paths.transcriptsRoot, 'T1');
    expect(cancelled.tasks.T1).toMatchObject({ label: 'Cancelled', transcripts: archive, cleanup: null });
    expect(cancelled.runs.R1).toMatchObject({ status: 'ended', outcome: 'cancelled' });
    expect(factory.executor.stopped).toEqual(['R1']);
    expect(factory.executor.archived).toEqual([{ sessionId, dir: archive, events: 2 }]);
    expect(await factory.git.worktrees(clone)).toEqual([]);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
  });

  test('closes its open attention request, and ends Cancelled, never failed, whatever its stopped run reports after', async () => {
    const { factory, operator, tui } = await running();
    const question = {
      id: 'toolu_01',
      questions: [{ question: 'Header or footer?', header: 'Place', options: [{ label: 'Header', description: '' }], multiSelect: false }],
    };
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.attentionQueue.length === 1);

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });
    factory.executor.report('R1', { type: 'runFailed', reason: 'The CLI exited.' });
    await operator.send({ type: 'daemon.status' });

    const cancelled = await tui.until((state) => state.tasks.T1?.transcripts !== null);
    expect(cancelled.tasks.T1?.label).toBe('Cancelled');
    expect(cancelled.runs.R1).toMatchObject({ status: 'ended', outcome: 'cancelled' });
    expect(cancelled.attentionQueue).toEqual([]);
  });
});

describe('Keep branch or Discard work', () => {
  const keep = { type: 'cancel' as const, taskId: 'T1', branch: 'keep' as const };
  const discard = { type: 'cancel' as const, taskId: 'T1', branch: 'discard' as const };
  const asked = (commits: string) => ({
    ok: false,
    reason: `${branch} holds ${commits} on origin. Keep branch or Discard work?`,
    choices: [
      { label: 'Keep branch', command: keep },
      { label: 'Discard work', command: discard },
    ],
  });

  test('is asked, cancelling nothing yet, when the task branch holds commits found nowhere else', async () => {
    const { factory, operator, tui } = await running();
    committed(factory, tui);
    committed(factory, tui, 'src/header.ts');

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual(asked('2 commits that aren’t'));

    expect(tui.state().tasks.T1?.label).toBe('Running');
    expect(factory.executor.stopped).toEqual([]);
  });

  test('Keep branch cancels the task and removes its worktree, leaving the branch in the operator’s clone', async () => {
    const { factory, operator, tui } = await running();
    committed(factory, tui);
    const { head } = (await factory.git.worktrees(clone))[0]!;
    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual(asked('1 commit that isn’t'));

    expect(await operator.send(keep)).toEqual({ ok: true });

    const cancelled = await tui.until((state) => state.tasks.T1?.transcripts !== null);
    expect(cancelled.tasks.T1).toMatchObject({ label: 'Cancelled', cleanup: null });
    expect(await factory.git.worktrees(clone)).toEqual([]);
    expect(await factory.git.localCommits(clone, branch)).toEqual([head]);
  });

  test('a kept branch stays kept when the cleanup fails and finishes once the daemon starts again', async () => {
    const { factory, operator, tui } = await running();
    committed(factory, tui);
    const { head } = (await factory.git.worktrees(clone))[0]!;
    factory.executor.failArchive('EACCES: permission denied');

    expect(await operator.send(keep)).toEqual({ ok: true });
    await tui.until((state) => !!state.tasks.T1?.cleanup?.problem);

    factory.executor.failArchive(null);
    await factory.restart();
    const later = watch(await factory.attach());
    await later.until((state) => state.tasks.T1?.transcripts !== null && state.tasks.T1?.cleanup === null);
    expect(await factory.git.worktrees(clone)).toEqual([]);
    expect(await factory.git.localCommits(clone, branch)).toEqual([head]);
  });

  test('Discard work cancels the task and removes its worktree and branch, commits and all', async () => {
    const { factory, operator, tui } = await running();
    committed(factory, tui);

    expect(await operator.send(discard)).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.transcripts !== null);
    expect(await factory.git.worktrees(clone)).toEqual([]);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
  });

  test('isn’t asked once the branch’s commits are on origin, pushed or merged, which a fresh fetch of the base branch finds', async () => {
    const { factory, operator, tui } = await running();
    committed(factory, tui);
    factory.git.merge(clone, branch, 'main');

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.transcripts !== null);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
  });

  test('is asked when origin can’t be reached, with what the factory last fetched', async () => {
    const { factory, operator, tui } = await running();
    committed(factory, tui);
    factory.git.cutOffOrigin(clone, 'fatal: unable to access origin');

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual(asked('1 commit that isn’t'));
  });
});
