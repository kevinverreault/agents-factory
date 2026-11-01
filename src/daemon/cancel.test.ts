// Seam 1: cancelling a root task (ADR 0011). Cancel ends the task at once,
// then archives its transcripts and removes its worktree. Its local task
// branch goes too, unless it holds commits on no branch of origin: then the
// cancel sheet asks once, Keep branch (the default) or Discard work.
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

const clone = resolve('/clones/widgets');
const branch = 'factory/T1-add-a-logout-button';

// A factory with T1 launched from a one-stage AFK preset, its run R1 live.
async function running(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched; worktree: string }> {
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
  const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return { factory, operator, tui, worktree: state.tasks.T1!.worktree! };
}

// The run committed work on the task branch.
function committed(factory: TestFactory, worktree: string): void {
  factory.git.editFile(worktree, 'src/logout.ts');
  factory.git.commitAll(worktree);
}

describe('cancelling a root task', () => {
  test('with no commits of its own, it asks nothing: the task ends Cancelled, its transcripts are archived and its worktree and branch removed', async () => {
    const { factory, operator, tui } = await running();
    const sessionId = factory.executor.started[0]!.sessionId;

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.transcripts !== null);
    const archive = join(factory.paths.transcriptsRoot, 'T1');
    expect(state.tasks.T1).toMatchObject({ label: 'Cancelled', transcripts: archive, cleanup: null });
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'cancelled' });
    expect(factory.executor.archived.map((archived) => archived.sessionId)).toEqual([sessionId]);
    expect(await factory.git.worktrees(clone)).toEqual([]);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
  });

  test('with commits pushed to origin, it asks nothing and removes the branch', async () => {
    const { factory, operator, tui, worktree } = await running();
    committed(factory, worktree);
    factory.git.push(clone, branch);

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.transcripts !== null);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
  });

  test('with commits on no branch of origin, the cancel sheet asks once, Keep branch or Discard work, and the task carries on meanwhile', async () => {
    const { factory, operator, tui, worktree } = await running();
    committed(factory, worktree);

    const asked = await operator.send({ type: 'cancel', taskId: 'T1' });

    expect(asked).toEqual({
      ok: false,
      reason: `${branch} has 1 commit that exists nowhere else.`,
      choose: [
        { label: 'Keep branch', command: { type: 'cancel', taskId: 'T1', branch: 'keep' } },
        { label: 'Discard work', command: { type: 'cancel', taskId: 'T1', branch: 'discard' } },
      ],
    });
    expect(tui.state().tasks.T1?.label).toBe('Running');
    expect(factory.executor.stopped).toEqual([]);
  });

  test('Keep branch ends the task Cancelled and removes its worktree, leaving the branch in the clone', async () => {
    const { factory, operator, tui, worktree } = await running();
    committed(factory, worktree);

    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'keep' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.transcripts !== null);
    expect(state.tasks.T1).toMatchObject({ label: 'Cancelled', cleanup: null });
    expect(await factory.git.worktrees(clone)).toEqual([]);
    expect(await factory.git.unpushed(clone, branch)).toHaveLength(1);
  });

  test('Discard work ends the task Cancelled and removes its worktree and branch', async () => {
    const { factory, operator, tui, worktree } = await running();
    committed(factory, worktree);

    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.transcripts !== null);
    expect(state.tasks.T1).toMatchObject({ label: 'Cancelled', cleanup: null });
    expect(await factory.git.worktrees(clone)).toEqual([]);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
  });

  test('a cancelled task’s conversation still replays, read from its archive', async () => {
    const { factory, operator, tui } = await running();
    factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Working on the logout button.' });

    await operator.send({ type: 'cancel', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.transcripts !== null);

    const events: ConversationEvent[] = [];
    operator.converse('R1', (event) => events.push(event));

    await expect.poll(() => events.map((event) => event.type === 'message' && event.text)).toEqual(['/factory:implement Add a logout button.', 'Working on the logout button.']);
    expect(factory.executor.historyReads.at(-1)).toMatchObject({ archive: join(factory.paths.transcriptsRoot, 'T1') });
  });
});
