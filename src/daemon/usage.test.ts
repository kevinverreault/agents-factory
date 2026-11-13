// Seam 1: usage metering (ADR 0008). Each run's usage is recorded per model
// from what the executor streams and totals, as a delta against its
// session's earlier runs, and every usage view is a query over runs.
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { usageViews } from '../usage/usage.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite, cost });
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

// A HITL task launched into its conversation on R1.
async function conversing(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
  await tui.until((state) => state.runs.R1?.status === 'active');
  return { factory, operator, tui };
}

describe('a run’s usage record', () => {
  test('a resumed session’s run records only its own delta, though its total counts the runs before', async () => {
    const { factory, operator, tui } = await conversing();
    factory.executor.report('R1', { type: 'usageTotaled', models: { [SONNET]: usage(1_000, 200, 5_000, 300, 0.5) } });
    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);
    // Parked idle, then reopened: R2 resumes the session.
    factory.clock.advance(minutes(31));
    await tui.until((state) => state.runs.R1?.outcome === 'parked');
    await operator.send({ type: 'open', taskId: 'T1' });
    await tui.until((state) => state.runs.R2?.status === 'active');
    expect(factory.executor.started[1]).toMatchObject({ runId: 'R2', resumesSession: true });

    factory.executor.report('R2', {
      type: 'usageTotaled',
      models: { [SONNET]: usage(1_400, 260, 9_000, 300, 0.7), [HAIKU]: usage(50, 10, 0, 0, 0.01) },
    });

    const state = await tui.until((state) => !!state.runs.R2?.usage[HAIKU]);
    expect(state.runs.R1!.usage).toEqual({ [SONNET]: usage(1_000, 200, 5_000, 300, 0.5) });
    expect(state.runs.R2!.usage[SONNET]).toEqual(usage(400, 60, 4_000, 0, expect.closeTo(0.2, 10)));
    expect(state.runs.R2!.usage[HAIKU]).toEqual(usage(50, 10, 0, 0, 0.01));
  });

  test('grows live as API messages stream, each counted once, and the run’s total brings it into line', async () => {
    const { factory, operator, tui } = await conversing();
    factory.executor.report('R1', { type: 'usageSampled', messageId: 'msg_1', model: SONNET, usage: usage(100, 10, 2_000) });
    factory.executor.report('R1', { type: 'usageSampled', messageId: 'msg_1', model: SONNET, usage: usage(100, 10, 2_000) });
    // An in-run subagent's message, under a name the total doesn't use.
    factory.executor.report('R1', { type: 'usageSampled', messageId: 'msg_2', model: 'haiku-alias', usage: usage(30, 5) });
    await settled(operator);
    expect(tui.state().runs.R1!.usage).toEqual({ [SONNET]: usage(100, 10, 2_000), 'haiku-alias': usage(30, 5) });

    factory.executor.report('R1', { type: 'usageTotaled', models: { [SONNET]: usage(100, 12, 2_000, 0, 0.03), [HAIKU]: usage(30, 5, 0, 0, 0.001) } });

    const state = await tui.until((state) => !!state.runs.R1?.usage[HAIKU]);
    expect(state.runs.R1!.usage).toEqual({ [SONNET]: usage(100, 12, 2_000, 0, 0.03), [HAIKU]: usage(30, 5, 0, 0, 0.001) });
  });

  test('a crashed CLI’s zeroed total leaves what the run streamed standing', async () => {
    const { factory, operator, tui } = await conversing();
    factory.executor.report('R1', { type: 'usageSampled', messageId: 'msg_1', model: SONNET, usage: usage(100, 10) });
    factory.executor.report('R1', { type: 'usageTotaled', models: { [SONNET]: usage(0, 0) } });
    factory.executor.report('R1', { type: 'runFailed', reason: 'The CLI exited.' });
    await settled(operator);

    expect(tui.state().runs.R1).toMatchObject({ status: 'ended', usage: { [SONNET]: usage(100, 10) } });
  });
});

describe('usage snapshots', () => {
  test('the latest reading of each usage window shows as spent and when it resets', async () => {
    const { factory, operator, tui } = await conversing();
    const now = factory.clock.now();
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'allowed', spent: 0.25, resetsAt: now + hours(3) });
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'allowed', spent: 0.1, resetsAt: now + hours(90) });
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'allowed_warning', spent: 0.82, resetsAt: now + hours(3) });
    await settled(operator);

    expect(tui.state().usage).toMatchObject({
      window: { spent: 0.82, resetsAt: now + hours(3) },
      weekly: { spent: 0.1, resetsAt: now + hours(90) },
    });
  });

  test('a reading that says nothing of what is spent keeps the last one for the same window', async () => {
    const { factory, operator, tui } = await conversing();
    const resetsAt = factory.clock.now() + hours(3);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'allowed', spent: 0.4, resetsAt });
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'allowed_warning', spent: null, resetsAt });
    await settled(operator);

    expect(tui.state().usage.window).toEqual({ spent: 0.4, resetsAt });
  });

  test('a reading that says nothing of what is spent keeps the last one when it names the same reset to within a minute', async () => {
    const { factory, operator, tui } = await conversing();
    const resetsAt = factory.clock.now() + hours(3);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'allowed', spent: 0.4, resetsAt: resetsAt + 734 });
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'allowed', spent: null, resetsAt });
    await settled(operator);

    expect(tui.state().usage.weekly).toEqual({ spent: 0.4, resetsAt });
  });

  test('a snapshot past its reset shows as unknown', async () => {
    const { factory, operator, tui } = await conversing();
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'allowed', spent: 0.5, resetsAt: factory.clock.now() + minutes(20) });
    await settled(operator);
    expect(tui.state().usage.window).not.toBeNull();

    factory.clock.advance(minutes(21));

    await tui.until((state) => state.usage.window === null);
  });

  test('a snapshot too old to trust shows as unknown, though its reset is still ahead', async () => {
    const { factory, operator, tui } = await conversing();
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'allowed', spent: 0.3, resetsAt: factory.clock.now() + hours(100) });
    await settled(operator);

    factory.clock.advance(minutes(59));
    await settled(operator);
    expect(tui.state().usage.weekly).toEqual({ spent: 0.3, resetsAt: expect.any(Number) });

    factory.clock.advance(minutes(2));
    await tui.until((state) => state.usage.weekly === null);
  });

  test('a spent window’s snapshot is trusted until its reset, however long since it was seen', async () => {
    const { factory, operator, tui } = await conversing();
    const resetsAt = factory.clock.now() + hours(4);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'rejected', spent: 1, resetsAt });
    await settled(operator);

    factory.clock.advance(hours(3));
    await settled(operator);

    expect(tui.state().usage.window).toEqual({ spent: 1, resetsAt });
  });

  test('snapshots outlast a daemon restart', async () => {
    const { factory, operator } = await conversing();
    const resetsAt = factory.clock.now() + hours(2);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'allowed', spent: 0.6, resetsAt });
    await settled(operator);

    await factory.restart();

    const reattached = watch(await factory.attach());
    expect((await reattached.until(() => true)).usage.window).toEqual({ spent: 0.6, resetsAt });
  });
});

describe('tokens per hour', () => {
  test('the last 12 hours’ tokens, oldest first, the hour now last, from every run’s per-minute usage', async () => {
    const { factory, operator, tui } = await conversing();
    // Each message lands before the clock moves on.
    const sampled = async (after: number, messageId: string, model: string, used: ReturnType<typeof usage>) => {
      factory.clock.advance(after);
      factory.executor.report('R1', { type: 'usageSampled', messageId, model, usage: used });
      await settled(operator);
    };
    await sampled(minutes(10), 'msg_1', SONNET, usage(100, 10, 1_000, 50));
    await sampled(minutes(40), 'msg_2', HAIKU, usage(200, 40));
    await sampled(minutes(20), 'msg_3', SONNET, usage(300, 0));

    expect(tui.state().usage.tokensPerHour).toEqual([...Array(10).fill(0), 1_400, 300]);

    // Hours with nothing in them roll the older ones off.
    factory.clock.advance(minutes(11 * 60));
    await tui.until((state) => state.usage.tokensPerHour.at(0) === 300);
    expect(tui.state().usage.tokensPerHour).toEqual([300, ...Array(11).fill(0)]);
  });
});

describe('usage limits on AFK runs', () => {
  async function running(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    const operator = await factory.attach();
    const tui = watch(operator);
    await tui.until(() => true);
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK', submit: true });
    await tui.until((state) => state.runs.R1?.status === 'active');
    return { factory, operator, tui };
  }

  test('a 5-hour limit is waited out in place: the run shows waiting for window, keeps its slot, and goes on by itself after the reset', async () => {
    const { factory, operator, tui } = await running();
    const resetsAt = factory.clock.now() + hours(2);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'five_hour', status: 'rejected', spent: 1, resetsAt });
    factory.executor.report('R1', { type: 'windowWaited', waitMs: hours(2) });

    let state = await tui.until((state) => state.tasks.T1?.label === 'Waiting for window');
    expect(state.runs.R1).toMatchObject({ status: 'active', waitingForWindow: resetsAt });
    expect(state.slots).toEqual({ active: 1, cap: 8 });
    expect(state.attentionQueue).toEqual([]);

    // Past the reset, the CLI's retry goes through and the run streams again.
    factory.clock.advance(hours(2));
    factory.executor.report('R1', { type: 'usageSampled', messageId: 'msg_1', model: SONNET, usage: usage(100, 10) });

    state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.runs.R1).toMatchObject({ status: 'active', waitingForWindow: null });
    expect(factory.executor.stopped).toEqual([]);
  });

  test('a weekly limit fails the run with an attention request naming the reset time', async () => {
    const { factory, operator, tui } = await running();
    const resetsAt = Date.UTC(2026, 10, 2, 14, 30);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'rejected', spent: 1, resetsAt });
    await settled(operator);
    // The CLI won't wait days: the request fails at once.
    factory.executor.report('R1', { type: 'runFailed', reason: 'API Error: 429 usage limit' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'failed' });
    expect(state.attentionQueue).toEqual([
      expect.objectContaining({ attention: 'failure', taskId: 'T1', reason: 'API Error: 429 usage limit. The weekly usage limit is spent: it resets Mon 2 Nov, 14:30.' }),
    ]);
  });

  test('a reading that says nothing of the status keeps a weekly limit spent, so the run’s failure still names the reset time', async () => {
    const { factory, operator, tui } = await running();
    const resetsAt = Date.UTC(2026, 10, 2, 14, 30);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'rejected', spent: 1, resetsAt });
    // The CLI's `/usage` reads the share, not the status, rounded below 100%.
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: null, spent: 0.996, resetsAt: resetsAt + 400 });
    await settled(operator);
    factory.executor.report('R1', { type: 'runFailed', reason: 'API Error: 429 usage limit' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.attentionQueue).toEqual([
      expect.objectContaining({ reason: 'API Error: 429 usage limit. The weekly usage limit is spent: it resets Mon 2 Nov, 14:30.' }),
    ]);
  });

  test('a reading that says nothing of the status of a window seen spent at last reads it spent', async () => {
    const { factory, operator, tui } = await running();
    const resetsAt = Date.UTC(2026, 10, 2, 14, 30);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: null, spent: 1, resetsAt });
    await settled(operator);
    factory.executor.report('R1', { type: 'runFailed', reason: 'API Error: 429 usage limit' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.attentionQueue).toEqual([
      expect.objectContaining({ reason: 'API Error: 429 usage limit. The weekly usage limit is spent: it resets Mon 2 Nov, 14:30.' }),
    ]);
  });

  test('a weekly limit that resets within the wait cap is waited out like a 5-hour one (ADR 0008)', async () => {
    const { factory, tui } = await running();
    const resetsAt = factory.clock.now() + hours(4);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'rejected', spent: 1, resetsAt });
    factory.executor.report('R1', { type: 'windowWaited', waitMs: hours(4) });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Waiting for window');
    expect(state.runs.R1).toMatchObject({ status: 'active', waitingForWindow: resetsAt });
    expect(state.attentionQueue).toEqual([]);
    expect(factory.executor.stopped).toEqual([]);
  });

  test('a run that fails while only another model’s weekly window is spent keeps its own reason', async () => {
    const { factory, operator, tui } = await running();
    expect(tui.state().runs.R1?.model).toBe(SONNET);
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day_opus', status: 'rejected', spent: 1, resetsAt: factory.clock.now() + hours(40) });
    await settled(operator);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The CLI exited.' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.attentionQueue).toEqual([expect.objectContaining({ attention: 'failure', reason: 'The CLI exited.' })]);
  });

  test('a run that fails with no usage window spent keeps its own reason', async () => {
    const { factory, tui } = await running();
    factory.executor.report('R1', { type: 'usageSnapshotSeen', window: 'seven_day', status: 'allowed', spent: 0.4, resetsAt: factory.clock.now() + hours(50) });
    factory.executor.report('R1', { type: 'runFailed', reason: 'The CLI exited.' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.attentionQueue).toEqual([expect.objectContaining({ attention: 'failure', reason: 'The CLI exited.' })]);
  });
});

describe('usage views', () => {
  test('task, tree, group, stage, ticket and model totals are queries over the same runs, so they agree', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    const { github, git, executor } = factory;
    github.addIssue('acme/widgets#11', { labels: ['ready-for-agent'] });
    const operator = await factory.attach();
    const tui = watch(operator);
    await tui.until(() => true);
    // T1 is a ticket task on #11: its implement run, then its review.
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', issues: ['#11'], groups: ['login'] });
    const worktree = (await tui.until((state) => state.tasks.T1?.liveRunId === 'R1')).tasks.T1!.worktree!;
    executor.report('R1', { type: 'usageTotaled', models: { [SONNET]: usage(1_000, 100, 0, 0, 0.25) } });
    git.editFile(worktree, 'src/logout.ts');
    git.commitAll(worktree);
    executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    // The review resumes the implement run's session: its total covers R1's too.
    executor.report('R2', { type: 'usageTotaled', models: { [SONNET]: usage(3_000, 300, 0, 0, 0.75) } });
    // T2 is a HITL grilling in two groups.
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the docs.', groups: ['login', 'docs'] });
    const r3 = (await tui.until((state) => !!state.tasks.T2?.liveRunId)).tasks.T2!.liveRunId!;
    executor.report(r3, { type: 'usageTotaled', models: { [HAIKU]: usage(300, 30, 0, 0, 0.125) } });
    await settled(operator);

    const views = usageViews(tui.state());

    const t1 = { [SONNET]: usage(3_000, 300, 0, 0, 0.75) };
    const t2 = { [HAIKU]: usage(300, 30, 0, 0, 0.125) };
    const both = { ...t1, ...t2 };
    expect(views.models).toEqual(both);
    expect(views.tasks).toEqual({ T1: t1, T2: t2 });
    expect(views.trees).toEqual({ T1: t1, T2: t2 });
    expect(views.groups).toEqual({ login: both, docs: t2 });
    expect(views.stages).toEqual({ implement: { [SONNET]: usage(1_000, 100, 0, 0, 0.25) }, review: { [SONNET]: usage(2_000, 200, 0, 0, 0.5) }, grill: t2 });
    expect(views.tickets).toEqual({ 'acme/widgets#11': t1 });
  });
});
