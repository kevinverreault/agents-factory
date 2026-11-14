// Seam 1: ticket tasks (ADR 0013), through the client protocol. Launching
// the `implement` preset on one issue ref with no sub-issues makes the task
// a ticket task for that issue: one implement run on the ticket, then the
// review, the PR body, which says `Closes <ticket>`, and open-pr. Its merged
// PR makes it Done, and the factory closes its ticket if GitHub left it open.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AutonomyLevel } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const READY = ['ready-for-agent'];
const TICKET = 'acme/widgets#39';
const MINUTE = 60_000;

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for L2 runs, and the ticket #39 on
// GitHub, with no sub-issues.
async function attached(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  factory.github.addIssue(TICKET, { labels: READY });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// The implement preset launched on the ticket ref alone, at `autonomy`.
const onTicket = (autonomy: AutonomyLevel = 'L1', extra: Partial<LaunchCommand> = {}): LaunchCommand => ({
  type: 'launchTask',
  repo: 'acme/widgets',
  preset: 'implement',
  issues: ['#39'],
  autonomy,
  ...extra,
});

// The run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Commits a change where the task's runs work: its container at L2, else its worktree.
function commitWork(factory: TestFactory, tui: Watched, autonomy: AutonomyLevel): void {
  const workdir = autonomy === 'L2' ? factory.sandbox.workdirOf('T1') : tui.state().tasks.T1!.worktree!;
  factory.git.editFile(workdir, 'src/login.ts');
  factory.git.commitAll(workdir);
}

// Works the ticket task's runs through its PR body: the implementation
// commits, the review finds `findings` and its fix pass leaves `leftOver`,
// then the PR body run writes `body`.
async function throughPrBody(
  { factory, tui }: Factory,
  autonomy: AutonomyLevel,
  { body = 'Adds a login form.', findings = [] as string[], leftOver = [] as string[] } = {},
): Promise<void> {
  await started(factory, 1);
  commitWork(factory, tui, autonomy);
  factory.executor.report('R1', { type: 'runCompleted' });
  await started(factory, 2);
  let next = 3;
  if (findings.length) {
    factory.executor.report('R2', { type: 'findingsReported', findings });
    factory.executor.report('R2', { type: 'runCompleted' });
    await started(factory, 3);
    factory.executor.report('R3', { type: 'findingsReported', findings: leftOver });
    factory.executor.report('R3', { type: 'runCompleted' });
    next = 4;
  } else factory.executor.report('R2', { type: 'runCompleted' });
  await started(factory, next);
  factory.executor.report(`R${next}`, { type: 'prBodyWritten', body });
  factory.executor.report(`R${next}`, { type: 'runCompleted' });
}

describe('launching implement on one issue ref with no sub-issues', () => {
  test('makes a ticket task for it, with merge policy operator, whose first run is one AFK implement run on the ticket', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send(onTicket())).toEqual({ ok: true, value: { taskId: 'T1' } });

    const running = await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(running.tasks.T1).toMatchObject({ kind: 'ticket', ticket: TICKET, mergePolicy: 'operator', mode: 'AFK', stage: 'implement', loop: null });
    const [first] = factory.executor.started;
    expect(first).toMatchObject({ runId: 'R1', mode: 'AFK' });
    expect(first!.firstMessage).toBe(`/factory:implement ${TICKET}`);
    expect(running.runs.R1).toMatchObject({ stage: 'implement', ticket: TICKET });
  });
});

describe('the ticket task’s stages', () => {
  test('its implement run completing moves on to the review, closing nothing on the task branch', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(onTicket());
    await started(factory, 1);
    commitWork(factory, tui, 'L1');

    factory.executor.report('R1', { type: 'runCompleted' });

    const reviewing = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(reviewing.tasks.T1).toMatchObject({ stage: 'review', loop: null });
    expect(factory.executor.started[1]!.firstMessage).toMatch(/^\/factory:code-review/);
    expect(reviewing.attentionQueue).toEqual([]);
    expect(factory.github.writes).toEqual([]);
    expect(factory.github.issueState(TICKET).open).toBe(true);
  });

  test('at L2 opens its PR with a body that says Closes its ticket, followed by the findings left over', async () => {
    const launched = await attached();
    const { factory, operator, tui } = launched;
    await operator.send(onTicket('L2'));

    await throughPrBody(launched, 'L2', { findings: ['The form has no label.', 'login() swallows errors.'], leftOver: ['login() swallows errors.'] });

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewing.tasks.T1).toMatchObject({ pr: { number: 101 }, mergePolicy: 'operator' });
    expect(reviewing.tasks.T1?.prBody).toBe('Adds a login form.\n\nCloses #39\n\n## Review findings left over\n\n- login() swallows errors.');
    expect(factory.github.pullRequests).toEqual([expect.objectContaining({ body: expect.stringMatching(/^Adds a login form\.\n\nCloses #39\n\n## Review findings left over/) })]);
  });

  test('a body that already closes its ticket says so once', async () => {
    const launched = await attached();
    await launched.operator.send(onTicket());

    await throughPrBody(launched, 'L1', { body: 'Adds a login form.\n\nFixes acme/widgets#39.' });

    const reviewing = await launched.tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewing.tasks.T1?.prBody).toBe('Adds a login form.\n\nFixes acme/widgets#39.');
  });

  test('a body that only mentions its ticket still gets Closes', async () => {
    const launched = await attached();
    await launched.operator.send(onTicket());

    await throughPrBody(launched, 'L1', { body: 'Implements #39, then #390.' });

    const reviewing = await launched.tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewing.tasks.T1?.prBody).toBe('Implements #39, then #390.\n\nCloses #39');
  });
});

describe('its merged PR', () => {
  // A ticket task at L2 In review with its PR #101 open.
  async function inReview(): Promise<Factory> {
    const launched = await attached();
    await launched.operator.send(onTicket('L2'));
    await throughPrBody(launched, 'L2');
    await launched.tui.until((state) => state.tasks.T1?.label === 'In review' && state.tasks.T1.pr !== null);
    return launched;
  }

  test('makes it Done, and the factory closes the ticket GitHub left open, as its App with a token for that write alone, naming the PR', async () => {
    const { factory } = await inReview();
    factory.github.merge(101);

    const tui = watch(await factory.attach());

    const done = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.resolving === null && state.tasks.T1.cleanup === null);
    expect(done.attentionQueue).toEqual([]);
    expect(factory.github.issueState(TICKET)).toMatchObject({ open: false, stateReason: 'completed' });
    const [close] = factory.github.writes;
    expect(factory.github.writes).toHaveLength(1);
    expect(close).toMatchObject({ action: 'close', ref: TICKET, token: { repo: 'acme/widgets', permissions: { issues: 'write', metadata: 'read' } } });
    expect(factory.github.minted.filter(({ token }) => token === close!.token.token)).toHaveLength(1);
    expect(close!.comment).toContain('https://github.com/acme/widgets/pull/101');
    expect(close!.comment).toContain('T1');
  });

  test('whose ticket GitHub closed makes it Done with no write', async () => {
    const { factory } = await inReview();
    factory.github.merge(101);
    factory.github.close(TICKET);

    const tui = watch(await factory.attach());

    await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.resolving === null && state.tasks.T1.cleanup === null);
    expect(factory.github.writes).toEqual([]);
  });

  test('whose ticket the factory couldn’t close is tried again at the next poll', async () => {
    const { factory, operator, tui } = await inReview();
    factory.github.merge(101);
    factory.github.failIssueWrites('Service Unavailable.');

    // Another TUI subscribing makes the daemon read the PR.
    watch(await factory.attach());

    const failed = await tui.until((state) => state.tasks.T1?.label === 'Done' && !!state.tasks.T1.resolving?.problem);
    expect(failed.tasks.T1?.resolving).toEqual({ problem: 'Service Unavailable.' });
    expect(factory.github.issueState(TICKET).open).toBe(true);
    factory.github.failIssueWrites(null);

    factory.clock.advance(15 * MINUTE);
    await operator.send({ type: 'daemon.status' });

    await tui.until((state) => state.tasks.T1?.resolving === null);
    expect(factory.github.issueState(TICKET).open).toBe(false);
    expect(factory.github.writes).toHaveLength(1);
  });
});

describe('the other implement launches', () => {
  test('a ref and a prompt: the prompt joins the ticket task’s first message as operator instructions', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send(onTicket('L1', { prompt: 'Mind the accessibility.' }));

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(tui.state().tasks.T1).toMatchObject({ kind: 'ticket', ticket: TICKET });
    expect(factory.executor.started[0]!.firstMessage).toBe(`/factory:implement ${TICKET}\n\n## Operator instructions\nMind the accessibility.`);
  });

  test('a prompt alone is still one plain implement run', async () => {
    const { factory, operator, tui } = await attached();

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: 'Fix the login bug.' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(tui.state().tasks.T1).toMatchObject({ kind: 'plain', ticket: null, mergePolicy: 'operator', loop: null });
    expect(factory.executor.started.map(({ firstMessage }) => firstMessage)).toEqual(['/factory:implement Fix the login bug.']);
  });

  test('a ref with sub-issues makes no ticket task of itself, but a spec task over them', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.addIssue('acme/widgets#10');
    factory.github.addIssue('acme/widgets#11', { parent: 'acme/widgets#10', labels: READY });

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', issues: ['#10'] });

    await tui.until((state) => state.tasks.T2?.liveRunId === 'R1');
    expect(tui.state().tasks.T1).toMatchObject({ kind: 'spec', ticket: null });
    expect(tui.state().tasks.T2).toMatchObject({ kind: 'ticket', ticket: 'acme/widgets#11', specTask: 'T1' });
  });

  test('a ref whose sub-issues can’t be read is refused, saying why', async () => {
    const { operator, tui } = await attached();

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', issues: ['#77'] })).toEqual({
      ok: false,
      reason: 'Couldn’t read acme/widgets#77’s sub-issues on GitHub as the factory’s App: GitHub refused the call (HTTP 404: Not Found).',
    });
    expect(tui.state().tasks).toEqual({});
  });
});
