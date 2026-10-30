// Seam 1: a HITL run idle on the operator's turn is parked by a persisted
// wall-clock deadline (ADR 0003), driven through the client protocol with a
// controllable clock.
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const minutes = (n: number) => n * 60_000;

// A HITL task launched and conversing, with the agent's first turn over.
async function waitingOnTheOperator(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
  factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Which identity provider times out?' });
  factory.executor.report('R1', { type: 'turnEnded' });
  await settled(operator);
  return { factory, operator, tui };
}

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

describe('the HITL idle park', () => {
  test('a HITL run idle on the operator’s turn for 30 minutes ends parked, frees its process, and its task is Ready for you', async () => {
    const { factory, operator, tui } = await waitingOnTheOperator();

    factory.clock.advance(minutes(29));
    await settled(operator);
    expect(tui.state().runs.R1).toMatchObject({ status: 'active', outcome: null });
    expect(factory.executor.stopped).toEqual([]);

    factory.clock.advance(minutes(1.5));
    const state = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(state.runs.R1).toMatchObject({ outcome: 'parked' });
    expect(state.tasks.T1).toMatchObject({ label: 'Ready for you', liveRunId: null });
    expect(state.attentionQueue).toEqual([{ kind: 'ready', taskId: 'T1' }]);
    expect(factory.executor.stopped).toEqual(['R1']);
  });

  test('only the operator’s turn counts: replying stops the idle clock, and it restarts when the agent’s turn ends', async () => {
    const { factory, operator, tui } = await waitingOnTheOperator();

    factory.clock.advance(minutes(20));
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' });
    // The agent works for a long turn.
    factory.clock.advance(minutes(45));
    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);
    factory.clock.advance(minutes(29));
    await settled(operator);
    expect(tui.state().runs.R1).toMatchObject({ status: 'active', outcome: null });

    factory.clock.advance(minutes(1.5));
    expect((await tui.until((state) => state.runs.R1?.status === 'ended')).runs.R1).toMatchObject({ outcome: 'parked' });
  });

  test('a turn that ends with the operator’s queued messages stays the agent’s, so the idle clock doesn’t start', async () => {
    const { factory, operator, tui } = await waitingOnTheOperator();
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' });
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'And only since Tuesday.' });
    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);

    factory.clock.advance(minutes(45));
    await settled(operator);
    expect(tui.state().runs.R1).toMatchObject({ status: 'active', outcome: null });

    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);
    factory.clock.advance(minutes(31));
    expect((await tui.until((state) => state.runs.R1?.status === 'ended')).runs.R1).toMatchObject({ outcome: 'parked' });
  });

  test('a question card left unanswered for 30 minutes parks the run', async () => {
    const { factory, operator, tui } = await waitingOnTheOperator();
    await operator.send({ type: 'sendMessage', taskId: 'T1', text: 'Okta, only on Safari.' });
    factory.executor.report('R1', {
      type: 'questionAsked',
      question: {
        id: 'Q1',
        questions: [
          {
            question: 'Which browser version?',
            header: 'Browser',
            options: [
              { label: 'Safari 18', description: 'Current' },
              { label: 'Safari 17', description: 'Previous' },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    await settled(operator);

    factory.clock.advance(minutes(31));

    expect((await tui.until((state) => state.runs.R1?.status === 'ended')).runs.R1).toMatchObject({ outcome: 'parked' });
  });

  test('a sleep longer than the deadline parks the run as soon as the machine wakes, not 30 minutes after', async () => {
    const { factory, operator, tui } = await waitingOnTheOperator();
    factory.clock.advance(minutes(10));

    factory.clock.sleep(minutes(120));
    const wokeAt = factory.clock.now();
    factory.clock.advance(5_000);

    const state = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(state.runs.R1).toMatchObject({ outcome: 'parked' });
    expect(state.runs.R1!.endedAt).toBeLessThanOrEqual(wokeAt + 5_000);
    expect(factory.executor.stopped).toEqual(['R1']);
  });

  test('reopening a parked HITL task starts a run that resumes the same session', async () => {
    const { factory, operator, tui } = await waitingOnTheOperator();
    factory.clock.advance(minutes(31));
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');

    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });

    // The resumed run starts on the operator's turn, so with no conversation
    // open the task stays Ready for you.
    const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(state.runs.R2).toMatchObject({ status: 'active' });
    const [first, resumed] = factory.executor.started;
    expect(resumed).toEqual({ ...first, runId: 'R2', resumesSession: true, firstMessage: null });
  });

  test('a reopened run starts on the operator’s turn, so it parks again if the operator leaves it idle', async () => {
    const { factory, operator, tui } = await waitingOnTheOperator();
    factory.clock.advance(minutes(31));
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');
    await operator.send({ type: 'open', taskId: 'T1' });

    factory.clock.advance(minutes(31));

    expect((await tui.until((state) => state.runs.R2?.status === 'ended')).runs.R2).toMatchObject({ outcome: 'parked' });
  });
});

// Until restart reconciliation parks every live HITL run (ADR 0002, #61),
// the run stays live across a restart, and only its deadline parks it.
describe('deadlines across a daemon restart', () => {
  test('a daemon restart keeps a pending deadline, which fires when it falls due', async () => {
    const { factory } = await waitingOnTheOperator();
    factory.clock.advance(minutes(10));

    await factory.restart();
    const operator = await factory.attach();
    const tui = watch(operator);
    factory.clock.advance(minutes(19));
    await settled(operator);
    expect(tui.state().runs.R1).toMatchObject({ status: 'active', outcome: null });

    factory.clock.advance(minutes(1.5));
    expect((await tui.until((state) => state.runs.R1?.status === 'ended')).runs.R1).toMatchObject({ outcome: 'parked' });
  });

  test('a deadline that passed while the daemon was down fires as soon as it starts', async () => {
    const { factory } = await waitingOnTheOperator();
    await factory.daemon().stop();
    factory.clock.advance(minutes(45));

    await factory.startDaemon();
    const tui = watch(await factory.attach());

    const state = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(state.runs.R1).toMatchObject({ outcome: 'parked', endedAt: factory.clock.now() });
    expect(state.tasks.T1).toMatchObject({ label: 'Ready for you' });
  });
});
