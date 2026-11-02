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

describe('usage views', () => {
  test('task, tree, group, stage, ticket and model totals are queries over the same runs, so they agree', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    await factory.registerRepo();
    const { github, git, executor } = factory;
    github.addIssue('acme/widgets#10');
    github.addIssue('acme/widgets#11', { parent: 'acme/widgets#10', labels: ['ready-for-agent'] });
    github.addIssue('acme/widgets#12', { parent: 'acme/widgets#10', labels: ['ready-for-agent'] });
    const operator = await factory.attach();
    const tui = watch(operator);
    await tui.until(() => true);
    // T1 loops over #11 and #12 at its implement stage.
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'], groups: ['login'] });
    const worktree = (await tui.until((state) => state.tasks.T1?.liveRunId === 'R1')).tasks.T1!.worktree!;
    executor.report('R1', { type: 'usageTotaled', models: { [SONNET]: usage(1_000, 100, 0, 0, 0.25) } });
    git.editFile(worktree, 'src/logout.ts');
    git.commitAll(worktree);
    executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    executor.report('R2', { type: 'usageTotaled', models: { [SONNET]: usage(2_000, 200, 0, 0, 0.5) } });
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
    expect(views.stages).toEqual({ implement: t1, grill: t2 });
    expect(views.tickets).toEqual({
      'acme/widgets#11': { [SONNET]: usage(1_000, 100, 0, 0, 0.25) },
      'acme/widgets#12': { [SONNET]: usage(2_000, 200, 0, 0, 0.5) },
    });
  });
});
