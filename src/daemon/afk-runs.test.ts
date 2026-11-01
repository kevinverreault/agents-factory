// Seam 1: AFK runs through the client protocol. A launch at an AFK stage
// queues an AFK run with its handoff fields, and the scheduler admits AFK
// runs under the slot cap. HITL and suspended runs hold no slot.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { handOff } from '../testing/handoff.ts';
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

const afk = (title: string, priority?: 'normal' | 'urgent') =>
  ({ type: 'createTask', repo: 'acme/widgets', title, mode: 'AFK', submit: true, ...(priority && { priority }) }) as const;

// The tasks whose runs the executor was asked to start, in order.
const startedTasks = (factory: TestFactory) => factory.executor.started.map((run) => run.taskId);

describe('the slot cap', () => {
  test('with the cap at 2, a third AFK run waits as Queued until a slot frees', async () => {
    const { factory, operator, tui } = await attached();
    for (const title of ['Fix the login bug', 'Fix the flaky test', 'Add dark mode']) await operator.send(afk(title));

    let state = await tui.until((state) => state.tasks.T3 !== undefined);
    expect([state.tasks.T1?.label, state.tasks.T2?.label, state.tasks.T3?.label]).toEqual(['Running', 'Running', 'Queued']);
    expect(state.slots).toEqual({ active: 2, cap: 2 });

    factory.executor.report('R1', { type: 'runCompleted' });
    state = await tui.until((state) => state.tasks.T3?.label === 'Running');
    expect(state.slots).toEqual({ active: 2, cap: 2 });
    expect(startedTasks(factory)).toEqual(['T1', 'T2', 'T3']);
  });

  test('changing the slot cap takes effect for the next admission, and outlasts a daemon restart', async () => {
    const { factory, operator, tui } = await attached();
    for (const title of ['Fix the login bug', 'Fix the flaky test', 'Add dark mode', 'Add SSO']) await operator.send(afk(title));
    await tui.until((state) => state.tasks.T4?.label === 'Queued');

    expect(await operator.send({ type: 'setSlotCap', cap: 3 })).toEqual({ ok: true });
    let state = await tui.until((state) => state.tasks.T3?.label === 'Running');
    expect(state.slots).toEqual({ active: 3, cap: 3 });

    // Lowering it stops nothing: it holds back the next admission.
    await operator.send({ type: 'setSlotCap', cap: 1 });
    factory.executor.report('R1', { type: 'runCompleted' });
    factory.executor.report('R2', { type: 'runCompleted' });
    state = await tui.until((state) => state.tasks.T2?.label === 'In review');
    expect(state.slots).toEqual({ active: 1, cap: 1 });
    expect(state.tasks.T4?.label).toBe('Queued');
    expect(await operator.send({ type: 'setSlotCap', cap: 0 })).toEqual({ ok: false, reason: 'The slot cap must be a whole number of at least 1.' });

    await factory.restart();
    const reattached = watch(await factory.attach());
    expect((await reattached.until(() => true)).slots).toEqual({ active: 1, cap: 1 });
  });

  test('an urgent task goes ahead of normal ones queued before it', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Fix the flaky test'));
    await operator.send(afk('Hotfix the outage', 'urgent'));

    expect((await tui.until((state) => state.tasks.T3 !== undefined)).tasks.T3).toMatchObject({ priority: 'urgent', label: 'Queued' });
    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T3?.label === 'Running');
    expect(tui.state().tasks.T2?.label).toBe('Queued');
    expect(startedTasks(factory)).toEqual(['T1', 'T3']);
  });

  test('a free slot goes to urgent work, then to work continuing something in flight, then first in first out', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Fix the flaky test'));
    // A conversation holds no slot, and handing it off continues its work.
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Plan the billing page', mode: 'HITL', submit: true });
    await operator.send({ type: 'open', taskId: 'T3' });
    expect((await tui.until((state) => state.tasks.T3?.liveRunId === 'R2')).slots).toEqual({ active: 1, cap: 1 });
    await handOff(operator, tui, factory.executor, 'T3');
    await operator.send(afk('Hotfix the outage', 'urgent'));

    const finish = async (runId: string, taskId: string) => {
      factory.executor.report(runId, { type: 'runCompleted' });
      await tui.until((state) => state.tasks[taskId]?.label === 'In review');
    };
    await finish('R1', 'T1');
    await finish('R3', 'T4');
    await finish('R4', 'T3');

    expect(startedTasks(factory)).toEqual(['T1', 'T3', 'T4', 'T3', 'T2']);
    // The handed-off run resumes the conversation on the brief.
    expect(factory.executor.started.at(-2)).toMatchObject({
      taskId: 'T3',
      mode: 'AFK',
      resumesSession: true,
      firstMessage: '# Handoff brief\n\nCarry the work on.',
    });
  });

  test('first in first out goes by when a task was queued, not created', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send({ ...afk('Fix the flaky test'), submit: false });
    await operator.send(afk('Add dark mode'));
    await operator.send({ type: 'submit', taskId: 'T2' });

    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T3?.label === 'Running');
    expect(tui.state().tasks.T2?.label).toBe('Queued');
  });
});

describe('launching at an AFK stage', () => {
  const implement: LaunchCommand = { type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#12'] };

  test('queues an AFK run at L1 with no HITL step, guarded by the global max turns', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send(implement)).toEqual({ ok: true, value: { taskId: 'T1' } });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.tasks.T1).toMatchObject({ mode: 'AFK', autonomy: 'L1', priority: 'normal' });
    expect(Object.values(state.runs)).toMatchObject([{ id: 'R1', mode: 'AFK', autonomy: 'L1', maxTurns: 300 }]);
    expect(factory.executor.started).toMatchObject([{ runId: 'R1', mode: 'AFK', autonomy: 'L1', maxTurns: 300 }]);
  });

  test('takes the operator’s max turns and priority, over the stage’s max_turns', async () => {
    const { factory, operator, tui } = await attached();
    mkdirSync(factory.paths.presetsDir, { recursive: true });
    writeFileSync(
      join(factory.paths.presetsDir, 'nightly.preset.yaml'),
      'stages:\n  - { id: implement, kind: run, skill: implement, args: "{{prompt}}", mode: AFK, max_turns: 25 }\n',
    );

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'nightly', prompt: 'Add dark mode.' });
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'nightly', prompt: 'Add SSO.', maxTurns: 40, priority: 'urgent', autonomy: 'L1' });

    const state = await tui.until((state) => state.tasks.T2?.label === 'Running');
    expect(state.tasks.T2?.priority).toBe('urgent');
    expect(factory.executor.started).toMatchObject([
      { taskId: 'T1', maxTurns: 25 },
      { taskId: 'T2', maxTurns: 40 },
    ]);
  });

  test('refuses max turns below 1, an unknown priority, and L2 until the sandbox exists', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send({ ...implement, maxTurns: 0 })).toEqual({ ok: false, reason: 'Max turns must be a whole number of at least 1.' });
    expect(await operator.send({ ...implement, priority: 'asap' as never })).toEqual({ ok: false, reason: 'asap is not a priority (normal or urgent).' });
    expect(await operator.send({ ...implement, autonomy: 'L2' })).toEqual({
      ok: false,
      reason: 'L2 runs in a sandbox, which the factory doesn’t have yet: launch at L1.',
    });

    await operator.send({ type: 'daemon.status' });
    expect(tui.state().tasks).toEqual({});
    expect(factory.executor.started).toEqual([]);
  });

  test('a HITL start stage’s run has no max turns', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.', maxTurns: 40 });

    expect((await tui.until((state) => state.runs.R1 !== undefined)).runs.R1).toMatchObject({ mode: 'HITL', maxTurns: null });
    expect(factory.executor.started).toMatchObject([{ mode: 'HITL', maxTurns: null }]);
  });
});

describe('an AFK run never takes chat', () => {
  test('a message or interrupt for a running AFK task is refused, pointing at takeover', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    const refusal = { ok: false, reason: 'T1 is AFK, so it takes no chat. Take it over to talk to it.' };
    expect(await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Use the new API.' })).toEqual(refusal);
    expect(await operator.send({ type: 'interrupt', taskId: 'T1' })).toEqual(refusal);
    expect(factory.executor.sent).toEqual([]);
    expect(factory.executor.interrupted).toEqual([]);
  });
});
