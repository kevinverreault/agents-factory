// Seam 1: the Lifecycle's rules hold through the client protocol.
import { afterEach, describe, expect, test } from 'vitest';
import { FACTORY_ALLOW_LIST } from '../permissions/permissions.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { openStore } from '../store/store.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

describe('runs', () => {
  test('a task has at most one live run: opening a conversation that is already open is refused', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Grill the plan', mode: 'HITL', submit: true });

    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });
    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({
      ok: false,
      reason: "T1 isn't ready for a conversation (it is In conversation).",
    });

    const state = await tui.until((state) => state.tasks.T1?.state === 'running');
    expect(Object.values(state.runs).filter((run) => run.taskId === 'T1' && run.status !== 'ended')).toHaveLength(1);
    expect(factory.executor.started.map((run) => run.runId)).toEqual(['R1']);
  });

  test('a queued AFK task starts a run on the executor while a slot is free', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.slots).toEqual({ active: 1, cap: 2 });
    expect(factory.executor.started).toEqual([
      { runId: 'R1', taskId: 'T1', mode: 'AFK', autonomy: 'L1', sessionId: 'S1', resumesSession: false, cwd: null, firstMessage: null, model: 'claude-sonnet-5-5', maxTurns: 300, credential: 'subscription-host', plugin: null, guards: null, allowRules: FACTORY_ALLOW_LIST, reports: [], child: false },
    ]);
  });
});

describe('tasks end only Done or Cancelled', () => {
  test('a failed run leaves its task needing you with a failure attention request, never failed', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });

    factory.executor.report('R1', { type: 'runFailed', reason: 'The agent hit max turns.' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'failed' });
    expect(state.attentionQueue).toEqual([
      {
        kind: 'attention',
        taskId: 'T1',
        repo: 'acme/widgets',
        requestId: 'A1',
        attention: 'failure',
        holdsRun: false,
        reason: 'The agent hit max turns.',
        question: null,
        permission: null,
      },
    ]);
  });

  test('cancelling a task ends its live run on the executor, and a cancelled task refuses every verb with a reason', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Cancelled');
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'cancelled' });
    expect(factory.executor.stopped).toEqual(['R1']);
    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1 is already Cancelled.' });
    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'Only a live AFK task (queued, running or needing you) can be taken over.',
    });
  });

  test('cancelling a task cascades to its whole subtree: every descendant ends Cancelled, their live runs end and their requests close', async () => {
    const { factory } = await attached();
    let operator = await factory.attach();
    for (const [title, mode] of [['Root', 'AFK'], ['Child', 'AFK'], ['Grandchild', 'HITL'], ['Bystander', 'HITL']] as const) {
      await operator.send({ type: 'createTask', repo: 'acme/widgets', title, mode, submit: false });
    }
    // Children arrive with their own slice: until then, the tree is made in the store.
    operator.close();
    await factory.daemon().stop();
    const store = openStore(factory.paths.storePath);
    const saved = store.loadLifecycle()!;
    saved.tasks.T2!.parent = 'T1';
    saved.tasks.T3!.parent = 'T2';
    store.saveLifecycle(saved);
    store.close();
    await factory.startDaemon();
    operator = await factory.attach();
    const tui = watch(operator);
    for (const taskId of ['T1', 'T2', 'T3', 'T4']) await operator.send({ type: 'submit', taskId });
    await operator.send({ type: 'open', taskId: 'T3' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1' && state.tasks.T2?.liveRunId === 'R2' && state.tasks.T3?.liveRunId === 'R3');
    factory.executor.askPermission('R2', { id: 'toolu_1', tool: 'Bash', input: { command: 'npm publish' } });
    await tui.until((state) => state.tasks.T2?.label === 'Needs you');

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T3?.label === 'Cancelled');
    expect(['T1', 'T2', 'T3', 'T4'].map((id) => state.tasks[id]!.label)).toEqual(['Cancelled', 'Cancelled', 'Cancelled', 'Ready for you']);
    for (const runId of ['R1', 'R2', 'R3']) expect(state.runs[runId]).toMatchObject({ status: 'ended', outcome: 'cancelled' });
    expect(factory.executor.stopped.sort()).toEqual(['R1', 'R2', 'R3']);
    expect(state.attentionQueue).toEqual([{ kind: 'ready', taskId: 'T4' }]);
  });

  test('a cancelled task needing you on a failure ends Cancelled, its failure request closed', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });
    factory.executor.report('R1', { type: 'runFailed', reason: 'The agent hit max turns.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Cancelled');
    expect(state.attentionQueue).toEqual([]);
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1 has no open attention request.' });
  });

  test('a completed AFK run puts its root task In review, and only the operator marks it Done', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });

    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(tui.state().attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);

    expect(await operator.send({ type: 'markDone', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: false, reason: 'T1 is already Done.' });
  });

  test('a run event for a run that already ended is not applied', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });
    await operator.send({ type: 'cancel', taskId: 'T1' });

    factory.executor.report('R1', { type: 'runCompleted' });
    await operator.send({ type: 'daemon.status' });

    expect(tui.state().tasks.T1?.label).toBe('Cancelled');
  });
});

describe('attention requests', () => {
  test('answering a suspended run’s request resumes the same run', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });

    factory.executor.askPermission('R1', { id: 'toolu_1', tool: 'Bash', input: { command: 'npm publish' } });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(tui.state().slots.active).toBe(0);

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } })).toEqual({ ok: true });
    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.tasks.T1?.liveRunId).toBe('R1');
    expect(state.attentionQueue).toEqual([]);
  });
});
