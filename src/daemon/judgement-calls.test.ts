// Seam 1: judgement calls at a factory merge (ADR 0014), through the client
// protocol. When the factory merges a task's PR, it first brings the PR
// body's judgement-calls section up to date with every call recorded since
// it was written, then posts one comment listing that task's calls as its
// App: on the spec, linking the ticket and the PR, for a ticket task under
// a spec; on the ticket for a ticket task with no spec. A task with no issue
// keeps them in its PR body alone, and a task with none posts nothing. A
// merge with review findings left over is itself a judgement call.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GitHubError } from '../github/github.ts';
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
const LONE_TICKET = 'acme/widgets#39';

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for contained runs, the spec #10 with
// its one ready ticket #11, and the ticket #39 under no spec.
async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  factory.github.addIssue(SPEC, { title: 'Sign-in' });
  factory.github.addIssue(TICKET, { title: 'A login form', parent: SPEC, labels: ['ready-for-agent'] });
  factory.github.addIssue(LONE_TICKET, { title: 'Sign out', labels: ['ready-for-agent'] });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// `implement` at L3 under full-auto, on a brief unless it names issues.
const fullAuto = (extra: Partial<LaunchCommand> = {}): LaunchCommand => ({
  type: 'launchTask',
  repo: 'acme/widgets',
  preset: 'implement',
  prompt: 'Add a logout button.',
  autonomy: 'L3',
  mergePolicy: 'unattended',
  ...extra,
});

const ASSUMED = { question: 'Where should the form go?', answer: 'On the landing page.', reason: 'Visitors land there first.' };
const ASSUMED_LINE = 'Assumed, asked “Where should the form go?”: On the landing page. (Visitors land there first.)';

// Works the task through its implement, review and PR body runs: the
// implement run commits, assuming `assumed` answers first, and the review
// reports `findings` to its fix pass, which leaves them over.
async function throughPr({ factory, tui }: Factory, taskId: string, { assumed = [], findings = [] }: { assumed?: (typeof ASSUMED)[]; findings?: string[] } = {}): Promise<void> {
  const next = async (after: string | null) =>
    (await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== after)).tasks[taskId]!.liveRunId!;
  let run = await next(null);
  for (const call of assumed) factory.executor.report(run, { type: 'answerAssumed', ...call });
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, `src/${taskId}.ts`);
  factory.git.commitAll(workdir);
  factory.executor.report(run, { type: 'runCompleted' });
  run = await next(run);
  if (findings.length) {
    factory.executor.report(run, { type: 'findingsReported', findings });
    factory.executor.report(run, { type: 'runCompleted' });
    run = await next(run);
    factory.executor.report(run, { type: 'findingsReported', findings });
  }
  factory.executor.report(run, { type: 'runCompleted' });
  run = await next(run);
  factory.executor.report(run, { type: 'prBodyWritten', body: `The work of ${taskId}.` });
  factory.executor.report(run, { type: 'runCompleted' });
  await tui.until((state) => !!state.tasks[taskId]?.pr);
}

// The task's PR merges: a repo with no checks lets it through once a second read finds none again.
async function merged({ factory, tui }: Factory, taskId: string): Promise<void> {
  await tui.until((state) => state.tasks[taskId]?.gate?.checks === 'none');
  factory.clock.advance(2 * MINUTE);
  await tui.until((state) => state.tasks[taskId]?.label === 'Done');
}

// The comments the factory posted on issues, beyond those closing them.
const comments = (factory: TestFactory) => factory.github.writes.filter(({ action }) => action === 'comment');

describe('a factory merge', () => {
  test('of a ticket task under a spec posts one comment on the spec listing its judgement calls, linking the ticket and the PR, with an issues-write token for that repo', async () => {
    const launched = await attached();
    const { factory, operator } = launched;
    await operator.send(fullAuto({ prompt: '', issues: ['#10'] }));

    await throughPr(launched, 'T2', { assumed: [ASSUMED] });
    await merged(launched, 'T2');

    await vi.waitFor(() => expect(comments(factory)).toHaveLength(1));
    const [comment] = comments(factory);
    expect(comment).toMatchObject({ ref: SPEC, token: { repo: 'acme/widgets', permissions: { issues: 'write', metadata: 'read' } } });
    expect(comment!.comment).toContain(TICKET);
    expect(comment!.comment).toContain('https://github.com/acme/widgets/pull/101');
    expect(comment!.comment).toContain(`- ${ASSUMED_LINE}`);
    expect(factory.github.issueState(SPEC).comments).toContain(comment!.comment);
    // The ticket itself gets none of it.
    expect(factory.github.issueState(TICKET).comments.join('\n')).not.toContain(ASSUMED.answer);
  });

  test('of a ticket task with no spec posts the comment on its ticket', async () => {
    const launched = await attached();
    const { factory, operator } = launched;
    await operator.send(fullAuto({ prompt: '', issues: ['#39'] }));

    await throughPr(launched, 'T1', { assumed: [ASSUMED] });
    await merged(launched, 'T1');

    await vi.waitFor(() => expect(comments(factory)).toHaveLength(1));
    expect(comments(factory)[0]).toMatchObject({ ref: LONE_TICKET, comment: expect.stringContaining(`- ${ASSUMED_LINE}`) });
    expect(comments(factory)[0]!.comment).toContain('https://github.com/acme/widgets/pull/101');
  });

  test('of a task with no issue posts nothing, and its PR body still lists the calls', async () => {
    const launched = await attached();
    const { factory, operator } = launched;
    await operator.send(fullAuto());

    await throughPr(launched, 'T1', { assumed: [ASSUMED] });
    await merged(launched, 'T1');

    await operator.send({ type: 'daemon.status' });
    expect(factory.github.writes).toEqual([]);
    expect(factory.github.pullRequests[0]!.body).toContain(`## Judgement calls\n\n- ${ASSUMED_LINE}`);
  });

  test('of a task with no judgement calls posts nothing, and leaves the PR body as it was opened', async () => {
    const launched = await attached();
    const { factory, operator } = launched;
    await operator.send(fullAuto({ prompt: '', issues: ['#39'] }));

    await throughPr(launched, 'T1');
    const opened = factory.github.pullRequests[0]!.body;
    await merged(launched, 'T1');

    await vi.waitFor(() => expect(factory.github.issueState(LONE_TICKET).open).toBe(false));
    expect(comments(factory)).toEqual([]);
    expect(factory.github.pullRequests[0]!.body).toBe(opened);
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['ready', 'merge']);
  });

  test('with review findings left over lists that merge as a judgement call, in the PR body and the comment', async () => {
    const launched = await attached();
    const { factory, operator } = launched;
    await operator.send(fullAuto({ prompt: '', issues: ['#39'] }));

    await throughPr(launched, 'T1', { findings: ['The button has no label.'] });
    expect(factory.github.pullRequests[0]!.body).not.toContain('Judgement calls');
    await merged(launched, 'T1');

    const line = 'Merged with a review finding left over: The button has no label.';
    await vi.waitFor(() => expect(comments(factory)).toHaveLength(1));
    expect(comments(factory)[0]!.comment).toContain(`- ${line}`);
    expect(factory.github.pullRequests[0]!.body).toContain(`## Judgement calls\n\n- ${line}`);
  });
});

describe('a judgement call recorded after the PR body was written', () => {
  test('by a CI fix run is in the PR body by the time it merges, with a PR-writing token for that repo', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    factory.github.runChecks('acme/widgets', 'pending');
    await operator.send(fullAuto({ prompt: '', issues: ['#39'] }));
    await throughPr(launched, 'T1');
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending');
    expect(factory.github.pullRequests[0]!.body).not.toContain('Judgement calls');

    // Red, the fix run assumes an answer as it fixes the build.
    factory.github.setChecks(101, 'red');
    factory.clock.advance(2 * MINUTE);
    const fix = (await tui.until((state) => !!state.tasks.T1?.liveRunId)).tasks.T1!.liveRunId!;
    factory.executor.report(fix, { type: 'answerAssumed', ...ASSUMED });
    const workdir = factory.sandbox.workdirOf('T1');
    factory.git.editFile(workdir, 'src/T1.ts', 'export const fixed = true;\n');
    factory.git.commitAll(workdir);
    factory.executor.report(fix, { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.gate?.checks === 'pending' && !state.tasks.T1.liveRunId);
    factory.github.setChecks(101, 'green');
    factory.clock.advance(2 * MINUTE);
    await tui.until((state) => state.tasks.T1?.label === 'Done');

    expect(factory.github.pullRequests[0]!.body).toContain(`## Judgement calls\n\n- ${ASSUMED_LINE}`);
    // Its body was written before the merge, with a token of its own.
    expect(factory.github.prWrites.map(({ action }) => action)).toEqual(['ready', 'edit', 'merge']);
    expect(factory.github.prWrites[1]).toMatchObject({ token: { repo: 'acme/widgets', permissions: { pull_requests: 'write', metadata: 'read' } } });
    await vi.waitFor(() => expect(comments(factory)).toHaveLength(1));
    expect(comments(factory)[0]!.comment).toContain(`- ${ASSUMED_LINE}`);
  });
});

describe('a comment GitHub refuses', () => {
  test('is tried again at the next poll, and posted once', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(fullAuto({ prompt: '', issues: ['#39'] }));
    await throughPr(launched, 'T1', { assumed: [ASSUMED] });
    factory.github.failIssueWrites('GitHub couldn’t be reached: socket hang up');
    await merged(launched, 'T1');
    await operator.send({ type: 'daemon.status' });
    expect(comments(factory)).toEqual([]);

    factory.github.failIssueWrites(null);
    factory.clock.advance(15 * MINUTE);

    await vi.waitFor(() => expect(comments(factory)).toHaveLength(1));
    await tui.until((state) => state.tasks.T1?.resolving === null);
    factory.clock.advance(15 * MINUTE);
    await operator.send({ type: 'daemon.status' });
    expect(comments(factory)).toHaveLength(1);
  });
});

describe('a comment that keeps failing', () => {
  test('holds up no closing of the ticket', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(fullAuto({ prompt: '', issues: ['#39'] }));
    await throughPr(launched, 'T1', { assumed: [ASSUMED] });
    // GitHub refuses every comment on the ticket, but lets it close.
    const commentIssue = factory.github.commentIssue.bind(factory.github);
    factory.github.commentIssue = async () => {
      throw new GitHubError('GitHub refused to comment on acme/widgets#39 (HTTP 403: Issue is locked).');
    };
    await merged(launched, 'T1');

    await tui.until((state) => state.tasks.T1?.resolving === null);
    expect(factory.github.issueState(LONE_TICKET).open).toBe(false);
    expect(comments(factory)).toEqual([]);

    factory.github.commentIssue = commentIssue;
    factory.clock.advance(15 * MINUTE);
    await vi.waitFor(() => expect(comments(factory)).toHaveLength(1));
  });
});
