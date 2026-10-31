// Seam 1: the attention queue (Needs you) through the client protocol: its
// order, AFK questions as attention requests that suspend their run, and
// requests that wait too long parking their run.
import { afterEach, describe, expect, test } from 'vitest';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
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

const minutes = (n: number) => n * 60_000;

const afk = (title: string) => ({ type: 'createTask', repo: 'acme/widgets', title, mode: 'AFK', submit: true }) as const;

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

// Each queue item as its task and what it waits on.
const rows = (queue: AttentionQueueItem[]) =>
  queue.map((item) => `${item.taskId} ${item.kind === 'attention' ? item.attention : item.kind}`);

describe('the Needs you order', () => {
  test('failures first, then other requests oldest first, then HITL tasks ready for you, then reviews', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 5 });
    await operator.send(afk('Fix the login bug'));
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Grill the billing plan', mode: 'HITL', submit: true });
    await operator.send(afk('Fix the flaky test'));
    await operator.send(afk('Add dark mode'));
    await operator.send(afk('Add SSO'));
    await tui.until((state) => state.tasks.T5?.label === 'Running');

    factory.executor.report('R2', { type: 'runCompleted' });
    factory.clock.advance(minutes(1));
    factory.executor.report('R4', { type: 'attentionRaised', kind: 'permission', reason: 'Run `npm publish`?' });
    await settled(operator);
    factory.clock.advance(minutes(1));
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'permission', reason: 'Run `docker build`?' });
    await settled(operator);
    factory.clock.advance(minutes(1));
    factory.executor.report('R3', { type: 'runFailed', reason: 'The agent hit max turns.' });

    const state = await tui.until((state) => state.attentionQueue.length === 5);
    expect(rows(state.attentionQueue)).toEqual(['T4 failure', 'T5 permission', 'T1 permission', 'T2 ready', 'T3 review']);
  });
});

const question = {
  id: 'toolu_01',
  questions: [
    {
      question: 'Which identity provider times out?',
      header: 'IdP',
      options: [
        { label: 'Okta', description: 'The workforce SSO' },
        { label: 'Auth0', description: 'The customer login' },
      ],
      multiSelect: false,
    },
  ],
};
const answers = { 'Which identity provider times out?': 'Okta' };

describe('an AFK question', () => {
  test('suspends its run and frees its slot, and shows in Needs you with what it asks', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Add dark mode'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });

    const state = await tui.until((state) => state.tasks.T2?.label === 'Running');
    expect(state.tasks.T1?.label).toBe('Needs you');
    expect(state.runs.R1?.status).toBe('suspended');
    expect(state.slots).toEqual({ active: 1, cap: 1 });
    expect(state.attentionQueue).toEqual([
      {
        kind: 'attention',
        taskId: 'T1',
        repo: 'acme/widgets',
        requestId: 'A1',
        attention: 'question',
        holdsRun: true,
        reason: 'Which identity provider times out?',
        question,
      },
    ]);
  });

  test('answering it resumes the run at once with the answers, even when every slot is taken', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Add dark mode'));
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.tasks.T2?.label === 'Running');

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: false, reason: 'Answer every question on the card.' });
    expect(await operator.send({ type: 'answer', taskId: 'T1', answers })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.tasks.T1?.liveRunId).toBe('R1');
    expect(state.slots).toEqual({ active: 2, cap: 1 });
    expect(state.attentionQueue).toEqual([]);
    expect(factory.executor.answered).toEqual([{ runId: 'R1', questionId: 'toolu_01', answers }]);
  });

  test('a run that fails while suspended on it supersedes the question with a failure request', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    factory.executor.report('R1', { type: 'runFailed', reason: 'The CLI exited.' });

    const state = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(state.runs.R1?.outcome).toBe('failed');
    expect(rows(state.attentionQueue)).toEqual(['T1 failure']);
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });
    expect((await tui.until((state) => state.tasks.T1?.liveRunId === 'R2')).tasks.T1?.label).toBe('Running');
  });
});

// Until restart reconciliation parks every suspended run (ADR 0003, #61), the
// run stays suspended across a restart, and only its deadline parks it.
describe('a request that waits too long', () => {
  test('parks its run after an hour, a deadline that outlasts a daemon restart, and stays in Needs you', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    factory.clock.advance(minutes(59));
    await settled(operator);
    expect(tui.state().runs.R1?.status).toBe('suspended');
    expect(factory.executor.stopped).toEqual([]);

    await factory.restart();
    const again = await factory.attach();
    const reattached = watch(again);
    factory.clock.advance(minutes(1.5));

    const state = await reattached.until((state) => state.runs.R1?.status === 'ended');
    expect(state.runs.R1?.outcome).toBe('parked');
    expect(state.tasks.T1).toMatchObject({ label: 'Needs you', liveRunId: null });
    expect(state.attentionQueue).toMatchObject([{ attention: 'question', holdsRun: false, question }]);
    expect(factory.executor.stopped).toEqual(['R1']);
  });

  test('answering it later queues a new run that resumes the session and opens on the answers', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    await settled(operator);
    factory.clock.advance(minutes(61));
    await tui.until((state) => state.runs.R1?.outcome === 'parked');

    expect(await operator.send({ type: 'answer', taskId: 'T1', answers })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.tasks.T1?.liveRunId).toBe('R2');
    expect(state.attentionQueue).toEqual([]);
    expect(factory.executor.answered).toEqual([]);
    expect(factory.executor.started.at(-1)).toMatchObject({
      runId: 'R2',
      mode: 'AFK',
      resumesSession: true,
      firstMessage:
        'While this conversation was parked, the operator answered your question:\n\n' +
        'Which identity provider times out? Okta\n\n' +
        'Carry on, unattended, from where this conversation left off.',
    });
  });
});
