// Seam 1: a task's session transcripts outlive Claude Code's retention sweep
// (ADR 0011). The operator's own `claude` sessions sweep the session
// directory the factory's runs share with their own period, so each run's
// transcript is archived as soon as the run ends, and put back from there
// when the sweep took it before the session resumes or replays.
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const minutes = (n: number) => n * 60_000;

// A HITL task whose conversation parked once the operator left it idle.
async function parked(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched; sessionId: string }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
  factory.executor.converse('R1', { type: 'message', from: 'agent', text: 'Which identity provider times out?' });
  factory.executor.report('R1', { type: 'turnEnded' });
  // Every change sent so far has gone through the daemon.
  await operator.send({ type: 'daemon.status' });
  factory.clock.advance(minutes(31));
  await tui.until((state) => state.runs.R1?.outcome === 'parked');
  return { factory, operator, tui, sessionId: factory.executor.started[0]!.sessionId };
}

const texts = (events: ConversationEvent[]) => events.flatMap((event) => (event.type === 'message' ? [event.text] : []));

test('a run’s transcript is archived for its task as soon as the run ends', async () => {
  const { factory, sessionId } = await parked();

  await expect.poll(() => factory.executor.archived).toEqual([{ sessionId, dir: join(factory.paths.transcriptsRoot, 'T1'), events: 2 }]);
});

test('a session the sweep took while its task was parked is back before the run resuming it starts', async () => {
  const { factory, operator, tui, sessionId } = await parked();
  await expect.poll(() => factory.executor.archived.length).toBe(1);
  factory.executor.sweep(sessionId);

  await operator.send({ type: 'open', taskId: 'T1' });

  await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
  expect(factory.executor.started.at(-1)).toMatchObject({ runId: 'R2', sessionId, resumesSession: true });
  expect(factory.executor.resumedWithoutTranscript).toEqual([]);
  const events: ConversationEvent[] = [];
  operator.converse('R2', (event) => events.push(event));
  await expect.poll(() => texts(events)).toEqual(['/factory:grill-with-docs Grill me about the login flow.', 'Which identity provider times out?']);
});

test('a parked conversation the sweep took still replays', async () => {
  const { factory, operator, sessionId } = await parked();
  await expect.poll(() => factory.executor.archived.length).toBe(1);
  factory.executor.sweep(sessionId);

  const events: ConversationEvent[] = [];
  operator.converse('R1', (event) => events.push(event));

  await expect.poll(() => texts(events)).toEqual(['/factory:grill-with-docs Grill me about the login flow.', 'Which identity provider times out?']);
});

test('a task whose session the sweep took before it ended keeps what its runs said in its archive', async () => {
  const { factory, operator, tui, sessionId } = await parked();
  await expect.poll(() => factory.executor.archived.length).toBe(1);
  factory.executor.sweep(sessionId);

  await operator.send({ type: 'cancel', taskId: 'T1' });
  await tui.until((state) => state.tasks.T1?.transcripts !== null);

  const events: ConversationEvent[] = [];
  operator.converse('R1', (event) => events.push(event));
  await expect.poll(() => texts(events)).toEqual(['/factory:grill-with-docs Grill me about the login flow.', 'Which identity provider times out?']);
});

test('a run’s transcript that can’t be archived when it ends holds nothing back: the task resumes, and its end archives it', async () => {
  const { factory, operator, tui } = await parked();
  factory.executor.failArchive('EACCES: permission denied');
  await operator.send({ type: 'open', taskId: 'T1' });
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
  factory.executor.failArchive(null);

  await operator.send({ type: 'cancel', taskId: 'T1' });

  const done = await tui.until((state) => state.tasks.T1?.transcripts !== null);
  expect(done.tasks.T1).toMatchObject({ label: 'Cancelled', cleanup: null });
});
