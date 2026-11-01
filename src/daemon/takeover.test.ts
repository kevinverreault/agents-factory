// Seam 1: takeover, AFK → HITL, the reverse of a handoff. The operator takes
// over a queued, running or needs-you AFK task: its open attention request is
// superseded, its live run ends taken over, and a HITL run opens on the same
// session. Handing it back goes through the same handoff sheet.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { handOff } from '../testing/handoff.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

// Two AFK stages: build resumes its session, check starts a fresh one.
const preset =
  'stages:\n' +
  '  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", exit: run-completed }\n' +
  '  - { id: check, kind: run, mode: AFK, skill: code-review, context: fresh }\n';

// A factory with T1 launched from `preset`, running its build stage on R1.
async function running(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'unattended.preset.yaml'), preset);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await launch(operator, 'Add a logout button.');
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  return { factory, operator, tui };
}

async function launch(operator: FactoryConnection, prompt: string): Promise<void> {
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt });
  if (!launched.ok) throw new Error(launched.reason);
}

const question = {
  id: 'toolu_1',
  questions: [{ question: 'Where does the button go?', header: 'Placement', options: [{ label: 'Header', description: '' }], multiSelect: false }],
};

describe('taking over', () => {
  test('a running AFK task: its run ends taken over, and the operator converses on the same session, on their turn, Ready for you', async () => {
    const { factory, operator, tui } = await running();

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    const taken = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(taken.runs.R1).toMatchObject({ status: 'ended', outcome: 'taken over' });
    expect(taken.runs.R2).toMatchObject({ status: 'active', mode: 'HITL', autonomy: null, turn: 'operator', stage: 'build' });
    expect(taken.tasks.T1).toMatchObject({ mode: 'HITL', autonomy: null, label: 'Ready for you' });
    expect(factory.executor.stopped).toEqual(['R1']);
    const [afk, hitl] = factory.executor.started;
    expect(hitl).toMatchObject({ runId: 'R2', mode: 'HITL', resumesSession: true, sessionId: afk!.sessionId, firstMessage: null, guards: null });
    // A HITL run holds no slot.
    expect(taken.slots).toMatchObject({ active: 0 });
  });

  test('a task that needs the operator: its open attention request is superseded and leaves Needs you', async () => {
    const { factory, operator, tui } = await running();
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    const taken = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(taken.attentionQueue.filter((item) => item.kind === 'attention')).toEqual([]);
    expect(taken.runs.R1).toMatchObject({ status: 'ended', outcome: 'taken over' });
    expect(factory.executor.started[1]).toMatchObject({ mode: 'HITL', resumesSession: true, sessionId: factory.executor.started[0]!.sessionId });
    // The superseded request takes no answer.
    expect(await operator.send({ type: 'answer', taskId: 'T1', answers: { 'Where does the button go?': 'Header' } })).toEqual({
      ok: false,
      reason: 'T1 has no open attention request.',
    });
  });

  test('a failed task that needs the operator opens on the failed run’s session', async () => {
    const { factory, operator, tui } = await running();
    factory.executor.report('R1', { type: 'runFailed', reason: 'The agent hit max turns.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    const taken = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(taken.attentionQueue).toEqual([{ kind: 'ready', taskId: 'T1' }]);
    expect(taken.runs.R1).toMatchObject({ outcome: 'failed' });
    expect(factory.executor.started[1]).toMatchObject({ mode: 'HITL', resumesSession: true, sessionId: factory.executor.started[0]!.sessionId });
  });

  test('a queued task that never ran starts its conversation on its opening, and frees nothing it never held', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await launch(operator, 'Add a login button.');
    await tui.until((state) => state.tasks.T2?.label === 'Queued');

    expect(await operator.send({ type: 'takeOver', taskId: 'T2' })).toEqual({ ok: true });

    const taken = await tui.until((state) => state.tasks.T2?.liveRunId !== null && state.tasks.T2?.liveRunId !== undefined);
    expect(taken.tasks.T2).toMatchObject({ mode: 'HITL', label: 'In conversation' });
    expect(factory.executor.started.at(-1)).toMatchObject({
      taskId: 'T2',
      mode: 'HITL',
      resumesSession: false,
      sessionId: taken.tasks.T2!.sessionId,
      firstMessage: '/factory:implement Add a login button.',
    });
    expect(taken.tasks.T1?.label).toBe('Running');
  });

  test('a task queued for a fresh-context stage converses on the session its last AFK run used, not an empty new one', async () => {
    const { factory, operator, tui } = await running();
    await launch(operator, 'Add a login button.');
    await tui.until((state) => state.tasks.T2?.label === 'Running');
    // Lowered, the cap holds the next stage back once R1's slot frees.
    await operator.send({ type: 'setSlotCap', cap: 1 });
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.stage === 'check' && state.tasks.T1.label === 'Queued');

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    const taken = await tui.until((state) => state.tasks.T1?.mode === 'HITL' && state.tasks.T1.liveRunId !== null);
    const build = factory.executor.started.find((run) => run.taskId === 'T1')!;
    expect(factory.executor.started.at(-1)).toMatchObject({ taskId: 'T1', mode: 'HITL', resumesSession: true, sessionId: build.sessionId, firstMessage: null });
    expect(taken.tasks.T1?.sessionId).toBe(build.sessionId);
  });

  test('frees the slot its run held for the next queued AFK task', async () => {
    const { operator, tui } = await running();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await launch(operator, 'Add a login button.');
    await tui.until((state) => state.tasks.T2?.label === 'Queued');

    await operator.send({ type: 'takeOver', taskId: 'T1' });

    const state = await tui.until((state) => state.tasks.T2?.label === 'Running');
    expect(state.tasks.T1?.label).toBe('Ready for you');
    expect(state.slots).toEqual({ active: 1, cap: 1 });
  });
});

describe('refusing a takeover', () => {
  test('a task In review, a HITL task and a cancelled one are refused with a reason', async () => {
    const { factory, operator, tui } = await running();
    const refusal = { ok: false, reason: 'Only a live AFK task (queued, running or needing you) can be taken over.' };
    await operator.send({ type: 'takeOver', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.mode === 'HITL');
    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual(refusal);

    await launch(operator, 'Add a login button.');
    const { liveRunId } = (await tui.until((state) => !!state.tasks.T2?.liveRunId)).tasks.T2!;
    factory.executor.report(liveRunId!, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T2?.stage === 'check' && !!state.tasks.T2.liveRunId && state.tasks.T2.liveRunId !== liveRunId);
    factory.executor.report(tui.state().tasks.T2!.liveRunId!, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T2?.label === 'In review');
    expect(await operator.send({ type: 'takeOver', taskId: 'T2' })).toEqual(refusal);

    await operator.send({ type: 'cancel', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.label === 'Cancelled');
    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual(refusal);
  });
});

describe('handing a taken-over task back', () => {
  test('goes through the handoff sheet, pre-filled from the stage it was taken over at, and queues an AFK run on the same session', async () => {
    const { factory, operator, tui } = await running();
    await operator.send({ type: 'takeOver', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    expect(await operator.send({ type: 'openHandoff', taskId: 'T1' })).toEqual({ ok: true });
    const opened = await tui.until((state) => state.tasks.T1?.handoff !== null);
    expect(opened.tasks.T1?.handoff).toMatchObject({ stage: 'build', continueAs: 'resume', autonomy: 'L1' });
    await operator.send({ type: 'closeHandoff', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.handoff === null);
    await handOff(operator, tui, factory.executor, 'T1');

    const back = await tui.until((state) => state.tasks.T1?.mode === 'AFK' && state.tasks.T1.liveRunId === 'R3');
    expect(back.runs.R2).toMatchObject({ status: 'ended', outcome: 'handed off' });
    expect(back.runs.R3).toMatchObject({ status: 'active', mode: 'AFK', stage: 'build' });
    expect(back.tasks.T1).toMatchObject({ autonomy: 'L1', label: 'Running' });
    expect(factory.executor.started.at(-1)).toMatchObject({
      runId: 'R3',
      mode: 'AFK',
      resumesSession: true,
      sessionId: factory.executor.started[0]!.sessionId,
    });
  });
});
