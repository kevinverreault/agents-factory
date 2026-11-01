// Seam 1: child tasks (ADR 0009, ADR 0011). An AFK run's agent delegates
// through the factory's tools: a child gets its own branch cut from the
// parent's tip, its own worktree and its own run of the `child` preset, and
// reports up when it ends. Only fire-and-forget children exist yet.
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
// `preset` is more of the preset file, such as its limits.
async function running(preset = ''): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched; worktree: string }> {
  const factory = await startTestFactory();
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(
    join(factory.paths.presetsDir, 'unattended.preset.yaml'),
    `${preset}stages:\n  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", exit: run-completed }\n`,
  );
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: 'Add a logout button.', tier: 'sonnet' });
  if (!launched.ok) throw new Error(launched.reason);
  const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return { factory, operator, tui, worktree: state.tasks.T1!.worktree! };
}

let calls = 0;
// The run's agent spawns a fire-and-forget child with `goal`.
function spawn(factory: TestFactory, runId: string, goal: string, more: Record<string, unknown> = {}) {
  return factory.executor.delegate(runId, { type: 'spawnChild', toolUseId: `toolu_${++calls}`, goal, await: false, ...more });
}

describe('spawning a child', () => {
  test('spawn_child creates a child task on <task-branch>--c1, cut from the parent’s tip, which runs the child preset on its goal', async () => {
    const { factory, tui, worktree } = await running();
    factory.git.editFile(worktree, 'src/logout.ts');
    factory.git.commitAll(worktree);
    const tip = (await factory.git.snapshot(worktree)).head;

    const reply = await spawn(factory, 'R1', 'Survey how the app signs users out.', { skill: 'research' });

    expect(reply).toEqual({ ok: true, text: expect.stringContaining(`Spawned T2 on ${branch}--c1.`) });
    const state = await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    expect(state.tasks.T2).toMatchObject({ parent: 'T1', depth: 1, mode: 'AFK', branch: `${branch}--c1`, child: { awaited: false, base: tip, report: null } });
    expect(state.tasks.T2!.preset?.name).toBe('child');
    expect(state.tasks.T2!.worktree).not.toBe(worktree);
    const child = (await factory.git.worktrees(clone)).find((found) => found.branch === `${branch}--c1`);
    expect(child?.head).toBe(tip);
    const started = factory.executor.started.find((run) => run.runId === 'R2')!;
    expect(started.firstMessage).toMatch(/^\/factory:research Survey how the app signs users out\.\n\n## Factory context\n/);
    expect(started.firstMessage).toContain(`cut from ${tip.slice(0, 7)} on ${branch}`);
    expect(started).toMatchObject({ mode: 'AFK', child: true, cwd: state.tasks.T2!.worktree });
  });

  test('a replay of the same spawn call returns the child it spawned', async () => {
    const { factory, tui } = await running();
    const call = { type: 'spawnChild' as const, toolUseId: 'toolu_same', goal: 'Survey sign-out.', await: false };

    const first = await factory.executor.delegate('R1', call);
    const again = await factory.executor.delegate('R1', call);

    expect(again).toEqual(first);
    await tui.until((state) => !!state.tasks.T2);
    expect(Object.keys(tui.state().tasks)).toEqual(['T1', 'T2']);
  });

  test('a second child gets --c2', async () => {
    const { factory, tui } = await running();
    await spawn(factory, 'R1', 'One thing.');
    await spawn(factory, 'R1', 'Another thing.');

    const state = await tui.until((state) => !!state.tasks.T3);
    expect(state.tasks.T3!.branch).toBe(`${branch}--c2`);
  });

  test('an awaited child is refused for now, and so is a goal that is blank', async () => {
    const { factory } = await running();

    expect(await spawn(factory, 'R1', 'Survey sign-out.', { await: true })).toMatchObject({ ok: false, error: expect.stringContaining('Awaited children aren’t supported yet') });
    expect(await spawn(factory, 'R1', '  ')).toMatchObject({ ok: false, error: expect.stringContaining('needs a goal') });
  });
});

describe('limits', () => {
  test('a task spawns at most 5 children: the sixth is an error to the agent, with no attention request', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 10 });
    for (let i = 1; i <= 5; i++) expect(await spawn(factory, 'R1', `Thing ${i}.`)).toMatchObject({ ok: true });

    const sixth = await spawn(factory, 'R1', 'Thing 6.');

    expect(sixth).toEqual({ ok: false, error: 'T1 has spawned 5 children, the most a task may: do this work yourself.' });
    expect(tui.state().attentionQueue).toEqual([]);
    expect(tui.state().tasks.T7).toBeUndefined();
  });

  test('a tree goes no deeper than root → child → grandchild', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 10 });
    await spawn(factory, 'R1', 'Child.');
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    expect(await spawn(factory, 'R2', 'Grandchild.')).toMatchObject({ ok: true });
    const state = await tui.until((state) => state.tasks.T3?.liveRunId === 'R3');
    expect(state.tasks.T3).toMatchObject({ parent: 'T2', depth: 2, branch: `${branch}--c1--c1` });

    expect(await spawn(factory, 'R3', 'Great-grandchild.')).toEqual({
      ok: false,
      error: 'T3 is at depth 2, and its tree goes no deeper than 2: do this work yourself.',
    });
    expect(tui.state().attentionQueue).toEqual([]);
  });

  test('a tree has at most 12 descendants', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 20 });
    // Two children of the root with five children each: 12.
    for (const n of [1, 2]) {
      const reply = await spawn(factory, 'R1', `Child ${n}.`);
      const id = /Spawned (T\d+)/.exec(reply.ok ? reply.text : '')![1]!;
      const state = await tui.until((state) => !!state.tasks[id]?.liveRunId);
      const runId = state.tasks[id]!.liveRunId!;
      for (let i = 1; i <= 5; i++) expect(await spawn(factory, runId, `Grandchild ${i}.`)).toMatchObject({ ok: true });
    }

    expect(await spawn(factory, 'R1', 'Child 3.')).toEqual({ ok: false, error: 'T1’s tree has 12 descendants, the most a tree may: do this work yourself.' });
  });

  test('a preset lowers the limits, never raises them', async () => {
    const { factory } = await running('limits: { children: 1 }\n');
    await spawn(factory, 'R1', 'One thing.');

    expect(await spawn(factory, 'R1', 'Another.')).toEqual({ ok: false, error: 'T1 has spawned 1 children, the most a task may: do this work yourself.' });
  });
});

describe('model tiers', () => {
  test('a child asking for a higher tier than its parent’s run is clamped to it; a lower one it gets', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 5 });

    await spawn(factory, 'R1', 'Think hard.', { tier: 'opus' });
    await spawn(factory, 'R1', 'Something small.', { tier: 'haiku' });

    const state = await tui.until((state) => !!state.runs.R2 && !!state.runs.R3);
    expect(state.tasks.T2!.tier).toBe('sonnet');
    expect(state.runs.R2!.tier).toBe('sonnet');
    expect(state.runs.R3!.tier).toBe('haiku');
  });

  test('the operator may re-tier a child to any tier', async () => {
    const { factory, operator, tui } = await running();
    await spawn(factory, 'R1', 'Think hard.');

    expect(await operator.send({ type: 'retier', taskId: 'T2', tier: 'opus' })).toEqual({ ok: true });
    expect((await tui.until((state) => state.tasks.T2?.tier === 'opus')).tasks.T2!.tier).toBe('opus');
  });
});

describe('progress and results', () => {
  test('report_progress sets the one-line status on the Tasks row', async () => {
    const { factory, tui } = await running();

    factory.executor.report('R1', { type: 'progressReported', status: 'Wiring the button\ninto the header.' });

    expect((await tui.until((state) => state.tasks.T1?.status !== null)).tasks.T1!.status).toBe('Wiring the button into the header.');
  });

  test('a child ends Done with its report, its commits and outcome added, which list_children shows its parent', async () => {
    const { factory, tui } = await running();
    await spawn(factory, 'R1', 'Survey sign-out.');
    const state = await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    const childTree = state.tasks.T2!.worktree!;
    factory.git.editFile(childTree, 'docs/notes.md');
    factory.git.commitAll(childTree);
    const commit = (await factory.git.snapshot(childTree)).head;

    factory.executor.report('R2', { type: 'resultReported', summary: 'Sign-out lives in auth.ts.', status: 'done', notes: 'No tests cover it.' });
    factory.executor.report('R2', { type: 'runCompleted', result: 'All done.' });

    const done = await tui.until((state) => state.tasks.T2?.label === 'Done');
    const report = { summary: 'Sign-out lives in auth.ts.', status: 'done', notes: 'No tests cover it.', branch: `${branch}--c1`, commits: [commit], outcome: 'completed' };
    expect(done.tasks.T2!.child!.report).toEqual(report);
    const listed = await factory.executor.delegate('R1', { type: 'listChildren' });
    expect(listed.ok && JSON.parse(listed.text)).toEqual([expect.objectContaining({ id: 'T2', state: 'Done', report })]);
  });

  test('a child that reports nothing has its final result text as its summary', async () => {
    const { factory, tui } = await running();
    await spawn(factory, 'R1', 'Survey sign-out.');
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');

    factory.executor.report('R2', { type: 'runCompleted', result: 'Sign-out is in auth.ts.' });

    const done = await tui.until((state) => state.tasks.T2?.label === 'Done');
    expect(done.tasks.T2!.child!.report).toMatchObject({ summary: 'Sign-out is in auth.ts.', status: 'completed', commits: [] });
  });

  test('only a child reports a result', async () => {
    const { factory, tui } = await running();
    factory.executor.report('R1', { type: 'resultReported', summary: 'Done.', status: 'done', notes: '' });
    factory.executor.report('R1', { type: 'progressReported', status: 'Still here.' });

    await tui.until((state) => state.tasks.T1?.status === 'Still here.');
    expect(tui.state().tasks.T1!.child).toBeNull();
  });
});

describe('cleanup', () => {
  test('a fire-and-forget child’s worktree and branch are removed when it ends, and it outlives its root being done', async () => {
    const { factory, operator, tui } = await running();
    await spawn(factory, 'R1', 'Survey sign-out.');
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(await operator.send({ type: 'markDone', taskId: 'T1', anyway: true })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.transcripts !== null);
    expect(tui.state().tasks.T2!.label).toBe('Running');
    expect(tui.state().tasks.T1!.rollup).toMatchObject({ running: 1 });

    factory.executor.report('R2', { type: 'runCompleted', result: 'Done.' });

    const state = await tui.until((state) => state.tasks.T2?.transcripts !== null);
    expect(state.tasks.T2).toMatchObject({ label: 'Done', cleanup: null });
    expect(await factory.git.worktrees(clone)).toEqual([]);
    await expect(factory.git.isMerged(clone, `${branch}--c1`, 'origin/main')).rejects.toThrow();
  });
});

describe('the tree', () => {
  test('rows roll up their descendants’ counts, and a failed child shows on its root’s summary line', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 10 });
    for (const goal of ['A.', 'B.', 'C.', 'D.']) await spawn(factory, 'R1', goal);
    await tui.until((state) => !!state.tasks.T5?.liveRunId);
    await spawn(factory, 'R5', 'Grandchild.');
    await tui.until((state) => !!state.tasks.T6?.liveRunId);
    factory.executor.report('R2', { type: 'runCompleted', result: 'Done.' });
    factory.executor.report('R3', { type: 'runFailed', reason: 'The run hit its max turns (300) before it finished.' });
    await operator.send({ type: 'cancel', taskId: 'T4' });
    const state = await tui.until((state) => state.tasks.T2?.label === 'Done' && state.tasks.T3?.label === 'Needs you' && state.tasks.T4?.label === 'Cancelled');

    expect(state.tasks.T1!.rollup).toEqual({
      done: 1,
      running: 2,
      needsYou: 1,
      cancelled: 1,
      failed: [{ taskId: 'T3', reason: 'The run hit its max turns (300) before it finished.' }],
    });
    expect(state.tasks.T5!.rollup).toMatchObject({ running: 1 });
    expect(state.tasks.T2!.rollup).toBeNull();
    expect(state.attentionQueue).toEqual([expect.objectContaining({ taskId: 'T3', attention: 'failure' })]);
  });

  test('a failed child can be retried, taken over or cancelled by the operator like any AFK task', async () => {
    const { factory, operator, tui } = await running();
    await spawn(factory, 'R1', 'Survey sign-out.');
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    factory.executor.report('R2', { type: 'runFailed', reason: 'Boom.' });
    await tui.until((state) => state.tasks.T2?.label === 'Needs you');

    expect(await operator.send({ type: 'answer', taskId: 'T2' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R3');
    expect(await operator.send({ type: 'takeOver', taskId: 'T2' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T2?.mode === 'HITL');
    expect(await operator.send({ type: 'cancel', taskId: 'T2' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T2?.label === 'Cancelled');
    expect(state.tasks.T2!.child!.report).toMatchObject({ status: 'cancelled', outcome: 'cancelled' });
    expect(state.tasks.T1!.label).toBe('Running');
  });

  test('cancel_child cancels the agent’s own child with its subtree, and no other task', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 10 });
    await spawn(factory, 'R1', 'Child.');
    await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    await spawn(factory, 'R2', 'Grandchild.');
    await tui.until((state) => !!state.tasks.T3?.liveRunId);

    expect(await factory.executor.delegate('R2', { type: 'cancelChild', id: 'T1' })).toEqual({
      ok: false,
      error: 'T1 isn’t a child of T2: you may cancel only your own children.',
    });
    expect(await factory.executor.delegate('R1', { type: 'cancelChild', id: 'T2' })).toMatchObject({ ok: true });

    const state = await tui.until((state) => state.tasks.T3?.label === 'Cancelled');
    expect(state.tasks.T2!.label).toBe('Cancelled');
    expect(state.tasks.T1!.label).toBe('Running');
  });
});
