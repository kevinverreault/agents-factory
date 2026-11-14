// Seam 1: semi-auto's gate check (ADR 0014), through the client protocol.
// Under `judged`, once a gated PR's checks are green, the factory queues a
// judging run: a fresh session at the sonnet tier on the factory's
// gate-check skill, opening on the PR's diff, the ticket and spec, the
// findings fix-once left over and the task's frozen rubric, and given only
// `report_verdict`. A merge verdict merges the PR, recorded as a judgement
// call; an ask, a run with no verdict or a failed one sends the task In
// review with the reason. A new commit voids the verdict, and the check runs
// again once the checks are green. Red after the fix run sends the task In
// review naming the checks, and questions reach the operator as at L2.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_MERGE_GATE } from '../merge-gate/merge-gate.ts';
import { NO_VERDICT, type Question } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const MINUTE = 60_000;
const SPEC = 'acme/widgets#10';
const TICKET = 'acme/widgets#11';
const LINT = { name: 'lint', url: null };

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for contained runs, the spec #10 with
// its one ready ticket #11.
async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  factory.github.addIssue(SPEC, { title: 'Sign-in' });
  factory.github.addIssue(TICKET, { title: 'A login form', parent: SPEC, labels: ['ready-for-agent'] });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// `implement` at L3 under semi-auto, on a brief unless it names issues.
const semiAuto = (extra: Partial<LaunchCommand> = {}): LaunchCommand => ({
  type: 'launchTask',
  repo: 'acme/widgets',
  preset: 'implement',
  prompt: 'Add a logout button.',
  autonomy: 'L3',
  mergePolicy: 'judged',
  ...extra,
});

// The run of the task live once it is a new one, not `after`.
async function nextRun({ tui }: Factory, taskId: string, after: string | null): Promise<string> {
  return (await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== after)).tasks[taskId]!.liveRunId!;
}

// Commits a change to the task's file in its container.
function commit(factory: TestFactory, taskId: string, content: string): void {
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, `src/${taskId}.ts`, content);
  factory.git.commitAll(workdir);
}

// Works the task through its implement, review and PR body runs, the review
// leaving `findings` over after its fix pass, to its PR #101 at its gate,
// its checks pending. Returns its last run.
async function throughPr(launched: Factory, taskId: string, { findings = [] }: { findings?: string[] } = {}): Promise<string> {
  const { factory, tui } = launched;
  factory.github.runChecks('acme/widgets', 'pending');
  let run = await nextRun(launched, taskId, null);
  commit(factory, taskId, 'export {};\n');
  factory.executor.report(run, { type: 'runCompleted' });
  run = await nextRun(launched, taskId, run);
  if (findings.length) {
    factory.executor.report(run, { type: 'findingsReported', findings });
    factory.executor.report(run, { type: 'runCompleted' });
    run = await nextRun(launched, taskId, run);
    factory.executor.report(run, { type: 'findingsReported', findings });
  }
  factory.executor.report(run, { type: 'runCompleted' });
  run = await nextRun(launched, taskId, run);
  factory.executor.report(run, { type: 'prBodyWritten', body: `The work of ${taskId}.` });
  factory.executor.report(run, { type: 'runCompleted' });
  await tui.until((state) => state.tasks[taskId]?.gate?.checks === 'pending');
  return run;
}

// The checks on PR #101 go green: the next poll queues the gate check's
// judging run. Returns its run id, once it is live.
async function greenToJudging(launched: Factory, taskId: string, after: string): Promise<string> {
  launched.factory.github.setChecks(101, 'green');
  launched.factory.clock.advance(2 * MINUTE);
  return nextRun(launched, taskId, after);
}

// What the executor started the run `runId` with.
function startOf(factory: TestFactory, runId: string) {
  const start = factory.executor.started.find((started) => started.runId === runId);
  if (!start) throw new Error(`${runId} never started.`);
  return start;
}

describe('semi-auto’s gate check', () => {
  test('green checks start a judging run, in a session of its own at the sonnet tier, given only report_verdict, on the diff, ticket, spec, leftover findings and rubric', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    // The operator's opus tier is the task's; the judging run is sonnet's whatever it is.
    await operator.send(semiAuto({ prompt: '', issues: ['#10'], tier: 'opus' }));
    const last = await throughPr(launched, 'T2', { findings: ['The form has no label.'] });
    expect(tui.state().tasks.T2).toMatchObject({ label: 'At merge gate', mergePolicy: 'judged' });

    const judging = await greenToJudging(launched, 'T2', last);

    const start = startOf(factory, judging);
    const implement = factory.executor.started.find((started) => started.taskId === 'T2')!;
    expect(start).toMatchObject({ mode: 'AFK', autonomy: 'L3', resumesSession: false, reports: ['verdict'], assumes: false, model: 'claude-sonnet-5-5' });
    expect(implement.model).toBe('claude-opus-5-5');
    expect(start.sessionId).not.toBe(implement.sessionId);
    expect(start.firstMessage).toMatch(/^\/factory:gate-check\n/);
    expect(start.firstMessage).toContain('PR #101');
    expect(start.firstMessage).toContain(factory.github.headOf(factory.github.pullRequests[0]!));
    expect(start.firstMessage).toContain('gh pr diff 101 --repo acme/widgets');
    expect(start.firstMessage).toContain(`Ticket: ${TICKET}, under the spec ${SPEC}`);
    expect(start.firstMessage).toContain('- The form has no label.');
    for (const line of DEFAULT_MERGE_GATE.rubric) expect(start.firstMessage).toContain(`- ${line}`);
    expect(start.firstMessage).toContain('report_verdict');
    // It holds a slot like any AFK run, and nothing merges meanwhile.
    const status = await tui.until((state) => state.tasks.T2?.liveRunId === judging);
    expect(status.slots.active).toBe(1);
    expect(status.tasks.T2!.label).toBe('Running');
    expect(factory.github.prWrites).toEqual([]);
  });

  test('a merge verdict merges the PR, and its reason is a judgement call in the PR body and on the spec', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto({ prompt: '', issues: ['#10'] }));
    const judging = await greenToJudging(launched, 'T2', await throughPr(launched, 'T2'));

    factory.executor.report(judging, { type: 'verdictReported', verdict: 'merge', reason: 'It does what the ticket says and nothing more.' });
    factory.executor.report(judging, { type: 'runCompleted' });

    const done = await tui.until((state) => state.tasks.T2?.label === 'Done');
    expect(done.attentionQueue).toEqual([]);
    expect(factory.github.prState(101).state).toBe('merged');
    const line = 'Merged on the gate check’s judgement: It does what the ticket says and nothing more.';
    expect(factory.github.pullRequests[0]!.body).toContain(`## Judgement calls\n\n- ${line}`);
    await vi.waitFor(() => expect(factory.github.writes.filter(({ action }) => action === 'comment')).toHaveLength(1));
    expect(factory.github.writes.find(({ action }) => action === 'comment')).toMatchObject({ ref: SPEC, comment: expect.stringContaining(`- ${line}`) });
  });

  test('an ask verdict puts the task In review with the reason on its Needs you item and in task detail, and nothing merges', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto());
    const judging = await greenToJudging(launched, 'T1', await throughPr(launched, 'T1'));
    const reason = 'It changes the session cookie, which the spec says nothing about.';

    factory.executor.report(judging, { type: 'verdictReported', verdict: 'ask', reason });
    factory.executor.report(judging, { type: 'runCompleted' });

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1', reason }]);
    expect(asked.tasks.T1).toMatchObject({ label: 'In review', sentToOperator: reason, gate: null });
    // Polled again, the same green head starts no second judging run.
    const runs = factory.executor.started.length;
    factory.clock.advance(2 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    await vi.waitFor(() => expect(factory.github.prReads.length).toBeGreaterThan(0));
    expect(factory.executor.started).toHaveLength(runs);
    expect(factory.github.prState(101).state).toBe('open');
    expect(factory.github.prWrites).toEqual([]);
  });

  test('a judging run that ends with no verdict counts as ask, with that as its reason', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto());
    const judging = await greenToJudging(launched, 'T1', await throughPr(launched, 'T1'));

    factory.executor.report(judging, { type: 'runCompleted' });

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1', reason: NO_VERDICT }]);
    expect(asked.tasks.T1).toMatchObject({ label: 'In review', sentToOperator: NO_VERDICT });
    expect(factory.github.prState(101).state).toBe('open');
  });

  test('a judging run that fails sends the task In review with the failure, rather than a failure request', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto());
    const judging = await greenToJudging(launched, 'T1', await throughPr(launched, 'T1'));

    factory.executor.report(judging, { type: 'runFailed', reason: 'The run hit its turn limit.' });

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1', reason: 'The judging run failed without a verdict: The run hit its turn limit.' }]);
    expect(factory.github.prState(101).state).toBe('open');
  });

  test('a new commit after the gate check voids it, and the check runs again once the checks are green', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto());
    const first = await greenToJudging(launched, 'T1', await throughPr(launched, 'T1'));
    factory.executor.report(first, { type: 'verdictReported', verdict: 'ask', reason: 'The button has no tests.' });
    factory.executor.report(first, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'In review');
    const askedHead = factory.github.headOf(factory.github.pullRequests[0]!);

    // The operator asks for tests: the run's commit is pushed to the PR.
    expect(await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Add a test.' })).toEqual({ ok: true });
    const changes = await nextRun(launched, 'T1', first);
    commit(factory, 'T1', 'export const tested = true;\n');
    factory.executor.report(changes, { type: 'runCompleted' });

    // Back at its gate, the new head's pending checks wait.
    const waiting = await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
    expect(waiting.tasks.T1).toMatchObject({ label: 'At merge gate', sentToOperator: null });
    expect(waiting.attentionQueue).toEqual([]);
    const newHead = factory.github.headOf(factory.github.pullRequests[0]!);
    expect(newHead).not.toBe(askedHead);

    const second = await greenToJudging(launched, 'T1', changes);
    expect(startOf(factory, second).firstMessage).toContain(newHead);
    expect(startOf(factory, second).sessionId).not.toBe(startOf(factory, first).sessionId);
    factory.executor.report(second, { type: 'verdictReported', verdict: 'merge', reason: 'Now tested.' });
    factory.executor.report(second, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prState(101).state).toBe('merged');
  });

  test('a merge verdict on a head the PR has moved on from merges nothing: the new head is judged afresh', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto());
    const judging = await greenToJudging(launched, 'T1', await throughPr(launched, 'T1'));
    // The operator pushes to the PR while it is judged: its head moves on, still green.
    const judged = factory.github.headOf(factory.github.pullRequests[0]!);
    factory.github.reportHead(101, 'f'.repeat(40));
    factory.github.setCommitChecks('f'.repeat(40), 'green');

    factory.executor.report(judging, { type: 'verdictReported', verdict: 'merge', reason: 'Fine.' });
    factory.executor.report(judging, { type: 'runCompleted' });

    const again = await nextRun(launched, 'T1', judging);
    expect(startOf(factory, again).firstMessage).toContain('f'.repeat(40));
    expect(startOf(factory, again).firstMessage).not.toContain(judged);
    expect(factory.github.prWrites).toEqual([]);
    expect(tui.state().tasks.T1!.label).toBe('Running');
  });

  test('red after the fix run puts the task In review naming the checks, not a failure request', async () => {
    const launched = await attached();
    const { factory, tui } = launched;
    await launched.operator.send(semiAuto());
    const last = await throughPr(launched, 'T1');
    factory.github.setChecks(101, 'red', [LINT]);
    factory.clock.advance(2 * MINUTE);
    const fix = await nextRun(launched, 'T1', last);
    commit(factory, 'T1', 'export const fixed = false;\n');
    factory.executor.report(fix, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');

    factory.github.setChecks(101, 'red', [LINT]);
    factory.clock.advance(2 * MINUTE);

    const reason = 'The checks on PR #101 of T1 are still failing after its fix run: lint.';
    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1', reason }]);
    expect(asked.tasks.T1).toMatchObject({ label: 'In review', sentToOperator: reason });
    expect(factory.github.prWrites).toEqual([]);
  });

  test('a question under semi-auto reaches the operator, as at L2', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto());
    const run = await nextRun(launched, 'T1', null);
    expect(startOf(factory, run)).toMatchObject({ autonomy: 'L3', assumes: false });
    const question: Question = {
      id: 'toolu_1',
      questions: [{ question: 'Where should the logout button go?', header: 'Placement', options: [{ label: 'Header', description: '' }, { label: 'Menu', description: '' }], multiSelect: false }],
    };

    factory.executor.report(run, { type: 'attentionRaised', kind: 'question', question });

    const asked = await tui.until((state) => state.attentionQueue.length === 1);
    expect(asked.attentionQueue).toEqual([expect.objectContaining({ taskId: 'T1', attention: 'question' })]);
    expect(factory.executor.declined).toEqual([]);
  });

  test('a judging run cut off by a crash is requeued as the judging run, resuming its own session, and its verdict still counts', async () => {
    const launched = await attached();
    const { factory, operator } = launched;
    await operator.send(semiAuto());
    const judging = await greenToJudging(launched, 'T1', await throughPr(launched, 'T1'));
    const session = startOf(factory, judging).sessionId;

    await factory.crash();
    await factory.startDaemon();
    const tui = watch(await factory.attach());
    const resumed = await nextRun({ ...launched, tui }, 'T1', judging);

    expect(startOf(factory, resumed)).toMatchObject({ sessionId: session, resumesSession: true, reports: ['verdict'], model: 'claude-sonnet-5-5' });
    factory.executor.report(resumed, { type: 'verdictReported', verdict: 'merge', reason: 'Fine.' });
    factory.executor.report(resumed, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prState(101).state).toBe('merged');
  });

  test('switched to full-auto while sent to the operator, the task goes back to its gate and merges', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(semiAuto());
    const judging = await greenToJudging(launched, 'T1', await throughPr(launched, 'T1'));
    factory.executor.report(judging, { type: 'verdictReported', verdict: 'ask', reason: 'Unsure.' });
    factory.executor.report(judging, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'In review');

    expect(await operator.send({ type: 'setMergePolicy', taskId: 'T1', mergePolicy: 'unattended' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Done');
    expect(factory.github.prState(101).state).toBe('merged');
  });
});
