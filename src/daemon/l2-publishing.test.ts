// Seam 1: publishing at L2 (ADR 0004, ADR 0006, ADR 0007), through the
// client protocol. At L2 the factory publishes unattended: in a Ralph loop it
// pushes the task branch as its App after each successful iteration, before
// closing that iteration's ticket, and the `open-pr` action stage pushes and
// opens the draft PR, so the root reaches In review with its PR open. Below
// L2 the action is skipped.
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AutonomyLevel } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { keepRalphLoop } from '../testing/ralph-loop-preset.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const READY = ['ready-for-agent'];
const clone = resolve('/clones/widgets');
const CONTENTS_WRITE = { contents: 'write', metadata: 'read' };

// A factory with a subscription token for L2 runs, and the spec
// acme/widgets#10 on GitHub, whose sub-issues are the tickets #11 and #12.
async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  keepRalphLoop(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  factory.github.addIssue('acme/widgets#10');
  factory.github.addIssue('acme/widgets#11', { parent: 'acme/widgets#10', labels: READY });
  factory.github.addIssue('acme/widgets#12', { parent: 'acme/widgets#10', labels: READY });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

// main-flow launched at its implement loop on the spec, at `autonomy`.
const looping = (autonomy: AutonomyLevel): LaunchCommand => ({
  type: 'launchTask',
  repo: 'acme/widgets',
  preset: 'main-flow',
  stage: 'implement',
  issues: ['#10'],
  autonomy,
});

// The task's run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Commits a change in the task's container, as its run's agent would.
function commitInContainer(factory: TestFactory, taskId: string, path = 'src/login.ts'): void {
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, path, `${path} from the container`);
  factory.git.commitAll(workdir);
}

describe('a successful L2 iteration', () => {
  test('pushes the task branch as the App, with a token narrowed to Contents, before closing its ticket', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(looping('L2'));
    await started(factory, 1);
    commitInContainer(factory, 'T1');
    const { branch } = tui.state().tasks.T1!;

    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    const tip = factory.git.branchTip(clone, branch!)!;
    expect(factory.github.pushes).toEqual([{ repo: 'acme/widgets', branch, tip, token: expect.objectContaining({ permissions: CONTENTS_WRITE }) }]);
    expect(factory.git.originTip(clone, branch!)).toBe(tip);
    expect(factory.github.issueState('acme/widgets#11')).toMatchObject({ open: false, stateReason: 'completed' });
    // Pushed first: the push's token was minted before the close's.
    const permissions = factory.github.minted.map(({ permissions }) => permissions);
    const pushedAt = permissions.findIndex((granted) => granted.contents === 'write');
    const closedAt = permissions.findIndex((granted) => granted.issues === 'write');
    expect(pushedAt).toBeGreaterThan(-1);
    expect(pushedAt).toBeLessThan(closedAt);
  });

  test('that the App can’t push leaves its ticket open and asks the operator, and answering pushes, then closes it', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(looping('L2'));
    await started(factory, 1);
    commitInContainer(factory, 'T1');
    const { branch } = tui.state().tasks.T1!;
    factory.github.unreachable('GitHub is down.');

    factory.executor.report('R1', { type: 'runCompleted' });

    const asked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(asked.attentionQueue).toMatchObject([
      {
        attention: 'github-write',
        reason: `The factory couldn’t push ${branch} for acme/widgets#11 on GitHub as its App: GitHub is down. Fix it, then answer to try again.`,
      },
    ]);
    factory.github.unreachable(null);
    expect(factory.github.issueState('acme/widgets#11').open).toBe(true);

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.git.originTip(clone, branch!)).toBe(factory.git.branchTip(clone, branch!));
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
  });

  test('changing workflow files asks the operator to push it by hand, and once they have, answering closes its ticket', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(looping('L2'));
    await started(factory, 1);
    commitInContainer(factory, 'T1', '.github/workflows/ci.yml');
    const { branch } = tui.state().tasks.T1!;

    factory.executor.report('R1', { type: 'runCompleted' });

    const asked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(asked.attentionQueue[0]).toMatchObject({ attention: 'github-write', reason: expect.stringContaining(`git push origin ${branch}`) });
    expect(asked.attentionQueue[0]).toMatchObject({ reason: expect.stringContaining('.github/workflows/ci.yml') });
    expect(factory.github.issueState('acme/widgets#11').open).toBe(true);

    factory.git.push(clone, branch!);
    await operator.send({ type: 'answer', taskId: 'T1' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
  });
});

// The implement preset launched on #39 at `autonomy`: implement, review,
// pr-body, then open-pr, which requires L2.
const implementing = (autonomy: AutonomyLevel): LaunchCommand => ({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: '#39', autonomy });

// Works the implement preset's runs up to its open-pr stage: the
// implementation commits (in its container at L2), the review finds
// nothing, and the PR body run writes the body.
async function throughPrBody(factory: TestFactory, tui: Watched, autonomy: AutonomyLevel): Promise<void> {
  await started(factory, 1);
  if (autonomy === 'L2') commitInContainer(factory, 'T1');
  else {
    const { worktree } = tui.state().tasks.T1!;
    factory.git.editFile(worktree!, 'src/login.ts');
    factory.git.commitAll(worktree!);
  }
  factory.executor.report('R1', { type: 'runCompleted' });
  await started(factory, 2);
  factory.executor.report('R2', { type: 'runCompleted' });
  await started(factory, 3);
  factory.executor.report('R3', { type: 'prBodyWritten', body: 'Adds a login form.' });
  factory.executor.report('R3', { type: 'runCompleted' });
}

describe('the open-pr action', () => {
  test('at L2 pushes the task branch and opens the draft PR as the App, and the root reaches In review with it open', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementing('L2'));

    await throughPrBody(factory, tui, 'L2');

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review');
    const { branch } = reviewing.tasks.T1!;
    const tip = factory.git.branchTip(clone, branch!)!;
    expect(reviewing.tasks.T1).toMatchObject({ pr: { number: 101, url: 'https://github.com/acme/widgets/pull/101', draft: true }, publishing: null });
    expect(factory.github.pushes).toEqual([{ repo: 'acme/widgets', branch, tip, token: expect.objectContaining({ permissions: CONTENTS_WRITE }) }]);
    expect(factory.github.pullRequests).toEqual([
      expect.objectContaining({ draft: true, head: branch, base: 'main', assignees: ['octo-operator'], body: expect.stringMatching(/^Adds a login form\./) }),
    ]);
    expect(reviewing.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    // The action is the factory's: no run of its own.
    expect(factory.executor.started).toHaveLength(3);
  });

  test('that the App can’t complete needs the operator, and answering tries the step again until the root reaches In review with its PR', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementing('L2'));
    factory.github.failPullRequests('Validation Failed.');

    await throughPrBody(factory, tui, 'L2');

    const asked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(asked.attentionQueue).toMatchObject([
      { attention: 'github-write', reason: 'The factory couldn’t open T1’s draft PR on GitHub as its App: Validation Failed. Fix it, then answer to try again.' },
    ]);
    expect(asked.tasks.T1).toMatchObject({ stage: 'open-pr', pr: null, publishing: { step: 'open-pr' } });
    factory.github.failPullRequests(null);

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewing.tasks.T1).toMatchObject({ pr: { number: 101 }, publishing: null });
    expect(reviewing.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.executor.started).toHaveLength(3);
  });

  test('taken over before its PR opened and handed back at L2, the root still reaches In review with its draft PR open', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementing('L2'));
    factory.github.failPullRequests('Validation Failed.');
    await throughPrBody(factory, tui, 'L2');
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    factory.github.failPullRequests(null);

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R4');
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    factory.executor.report('R4', { type: 'briefWritten', brief: { goal: 'Open the PR.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
    const { brief, tier, maxTurns } = (await tui.until((state) => !!state.tasks.T1?.handoff?.brief)).tasks.T1!.handoff!;
    expect(await operator.send({ type: 'handoff', taskId: 'T1', brief: brief!, continueAs: 'resume', autonomy: 'L2', tier, maxTurns })).toEqual({ ok: true });
    await started(factory, 5);
    factory.executor.report('R5', { type: 'runCompleted' });

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review' && state.tasks.T1.publishing === null);
    expect(reviewing.tasks.T1).toMatchObject({ pr: { number: 101, draft: true } });
    expect(factory.github.pullRequests).toHaveLength(1);
  });

  test('is skipped at L1: the root reaches In review with its branch local', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementing('L1'));

    await throughPrBody(factory, tui, 'L1');

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewing.tasks.T1).toMatchObject({ pr: null, publishing: null });
    expect(factory.github.pushes).toEqual([]);
    expect(factory.github.pullRequests).toEqual([]);
  });
});

describe('Request changes on an L2 root with its draft PR', () => {
  test('pushes what the changes run committed to the PR, and the root is back In review', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementing('L2'));
    await throughPrBody(factory, tui, 'L2');
    const { branch } = (await tui.until((state) => state.tasks.T1?.label === 'In review')).tasks.T1!;

    expect(await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Validate the email field.' })).toEqual({ ok: true });
    await started(factory, 4);
    commitInContainer(factory, 'T1', 'src/validate.ts');
    factory.executor.report('R4', { type: 'runCompleted' });

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review' && state.tasks.T1.publishing === null && factory.github.pushes.length === 2);
    const tip = factory.git.branchTip(clone, branch!)!;
    expect(factory.github.pushes.at(-1)).toMatchObject({ branch, tip });
    expect(factory.git.originTip(clone, branch!)).toBe(tip);
    expect(reviewing.tasks.T1).toMatchObject({ pr: { number: 101 } });
    expect(factory.github.pullRequests).toHaveLength(1);
    expect(reviewing.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
  });
});

describe('an L2 root', () => {
  test('pushes each ticket before closing it, then goes In review with its draft PR open on every commit', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(looping('L2'));
    await started(factory, 1);
    const { branch } = tui.state().tasks.T1!;
    commitInContainer(factory, 'T1', 'src/login.ts');
    factory.executor.report('R1', { type: 'runCompleted' });
    await started(factory, 2);
    commitInContainer(factory, 'T1', 'src/logout.ts');
    factory.executor.report('R2', { type: 'runCompleted' });
    // Both tickets closed: the review, then the PR body.
    await started(factory, 3);
    // The executor may start the run before its patch reaches the TUI.
    expect((await tui.until((state) => !!state.runs.R3)).runs.R3).toMatchObject({ stage: 'review' });
    factory.executor.report('R3', { type: 'runCompleted' });
    await started(factory, 4);
    factory.executor.report('R4', { type: 'prBodyWritten', body: 'Adds login and logout.' });
    factory.executor.report('R4', { type: 'runCompleted' });

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review');
    const tip = factory.git.branchTip(clone, branch!)!;
    expect(reviewing.tasks.T1).toMatchObject({ stage: 'open-pr', pr: { number: 101, draft: true }, publishing: null });
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
    expect(factory.github.issueState('acme/widgets#12').open).toBe(false);
    // One push per iteration, then open-pr's, which finds nothing new to send.
    expect(factory.github.pushes.map((push) => push.branch)).toEqual([branch, branch]);
    expect(factory.git.originTip(clone, branch!)).toBe(tip);
    expect(factory.github.pullRequests).toEqual([expect.objectContaining({ head: branch, draft: true })]);
    expect(factory.github.pullRequests[0]!.body).toContain('Implements #11');
    expect(factory.github.pullRequests[0]!.body).toContain('Implements #12');
  });
});

describe('cancelling an L2 loop', () => {
  test('deletes the task branch it pushed from GitHub, though it has no PR yet', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(looping('L2'));
    await started(factory, 1);
    commitInContainer(factory, 'T1');
    const { branch } = tui.state().tasks.T1!;
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' });

    await vi.waitFor(() => expect(factory.github.branchDeletes).toEqual([expect.objectContaining({ repo: 'acme/widgets', branch })]));
    expect(factory.git.originTip(clone, branch!)).toBeNull();
  });
});

describe('an L2 loop taken over before it pushed its iteration', () => {
  test('handed back at L2, pushes the branch and closes that ticket, then picks the next', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(looping('L2'));
    await started(factory, 1);
    commitInContainer(factory, 'T1');
    const { branch } = tui.state().tasks.T1!;
    factory.github.unreachable('GitHub is down.');
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    factory.github.unreachable(null);

    await operator.send({ type: 'takeOver', taskId: 'T1' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    factory.executor.report('R2', { type: 'briefWritten', brief: { goal: 'Carry the work on.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
    const { brief, tier, maxTurns } = (await tui.until((state) => !!state.tasks.T1?.handoff?.brief)).tasks.T1!.handoff!;
    expect(await operator.send({ type: 'handoff', taskId: 'T1', brief: brief!, continueAs: 'fresh', autonomy: 'L2', tier, maxTurns })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    expect(tui.state().runs.R3).toMatchObject({ ticket: 'acme/widgets#12' });
    expect(factory.git.originTip(clone, branch!)).toBe(factory.git.branchTip(clone, branch!));
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
  });
});

describe('a successful L1 iteration', () => {
  test('closes its ticket with nothing pushed: its code stays on the operator’s machine', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(looping('L1'));
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    const { worktree, branch } = tui.state().tasks.T1!;
    factory.git.editFile(worktree!, 'src/login.ts');
    factory.git.commitAll(worktree!);

    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
    expect(factory.github.pushes).toEqual([]);
    expect(factory.git.originTip(clone, branch!)).toBeNull();
  });
});
