// Seam 1: cancelling ticket tasks and spec tasks (ADR 0013), through the
// client protocol. Cancelling a ticket task closes its draft PR and leaves
// its ticket open: its spec task marks the ticket skipped, launches it no
// more, and keeps the tickets it blocks blocked. Once nothing more can be
// launched and nothing is in flight, the spec task asks the operator to
// relaunch a skipped ticket, end leaving the spec open, or close the spec
// anyway. Cancelling the spec task cancels every unmerged ticket task
// under one cancel, with one Keep branch / Discard work question.
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const READY = ['ready-for-agent'];
const SPEC = 'acme/widgets#10';
const clone = resolve('/clones/widgets');

type Factory = { factory: TestFactory; operator: FactoryConnection; tui: Watched };

// A factory with a subscription token for L2 runs, and the spec #10 on
// GitHub with its sub-issues: #11 ready, #12 ready but blocked by #11, and
// #15 ready. Launched at L2 on the spec, T2 works #11 and T3 #15.
async function launched(): Promise<Factory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  await factory.registerRepo();
  const { github } = factory;
  github.addIssue(SPEC, { title: 'Sign-in' });
  github.addIssue('acme/widgets#11', { title: 'A login form', parent: SPEC, labels: READY });
  github.addIssue('acme/widgets#12', { title: 'Remember me', parent: SPEC, labels: READY, blockedBy: ['acme/widgets#11'] });
  github.addIssue('acme/widgets#15', { title: 'Sign out', parent: SPEC, labels: READY });
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  expect(await operator.send(onSpec)).toEqual({ ok: true, value: { taskId: 'T1' } });
  await tui.until((state) => !!state.tasks.T2?.liveRunId && !!state.tasks.T3?.liveRunId);
  return { factory, operator, tui };
}

const onSpec: LaunchCommand = { type: 'launchTask', repo: 'acme/widgets', preset: 'implement', issues: ['#10'], autonomy: 'L2' };

// The ticket tasks, by their ticket.
const ticketTasks = (state: FactoryState) =>
  Object.fromEntries(Object.values(state.tasks).flatMap((task) => (task.kind === 'ticket' && task.ticket ? [[task.ticket, task.id]] : [])));

// Where each ticket of T1's set stands.
const ticketStates = (state: FactoryState) => Object.fromEntries((state.tasks.T1?.ticketSet?.tickets ?? []).map(({ ref, state }) => [ref, state]));

// The open attention requests, leaving out the PRs in review.
const requests = (state: FactoryState) => state.attentionQueue.filter(({ kind }) => kind === 'attention');

// Works the ticket task `taskId`'s runs at L2 through its PR body, then
// waits for it In review with its PR, whose number it returns.
async function toReview({ factory, tui }: Factory, taskId: string): Promise<number> {
  let state = await tui.until((state) => !!state.tasks[taskId]?.liveRunId);
  let run = state.tasks[taskId]!.liveRunId!;
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, `src/${taskId}.ts`);
  factory.git.commitAll(workdir);
  factory.executor.report(run, { type: 'runCompleted' });
  state = await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== run);
  run = state.tasks[taskId]!.liveRunId!;
  factory.executor.report(run, { type: 'runCompleted' });
  state = await tui.until((state) => !!state.tasks[taskId]?.liveRunId && state.tasks[taskId].liveRunId !== run);
  run = state.tasks[taskId]!.liveRunId!;
  factory.executor.report(run, { type: 'prBodyWritten', body: `The work of ${taskId}.` });
  factory.executor.report(run, { type: 'runCompleted' });
  state = await tui.until((state) => state.tasks[taskId]?.label === 'In review' && !!state.tasks[taskId].pr);
  return state.tasks[taskId]!.pr!.number;
}

// Someone merges the PR on GitHub, and a TUI attaching makes the daemon read it.
async function merge({ factory }: Factory, number: number): Promise<void> {
  factory.github.merge(number);
  watch(await factory.attach());
}

describe('cancelling a ticket task', () => {
  test('closes its draft PR and leaves its ticket open; its spec task marks the ticket skipped, never launching it again, and the tickets it blocks stay blocked', async () => {
    const spec = await launched();
    const { factory, operator, tui } = spec;
    const pr = await toReview(spec, 'T2');

    expect(await operator.send({ type: 'cancel', taskId: 'T2', branch: 'discard' })).toEqual({ ok: true });

    let state = await tui.until((state) => state.tasks.T2?.label === 'Cancelled' && state.tasks.T2.cleanup === null);
    expect(factory.github.pullRequests.find(({ number }) => number === pr)?.state).toBe('closed');
    expect(factory.github.issueState('acme/widgets#11').open).toBe(true);
    expect(factory.github.writes).toEqual([]);
    state = await tui.until((state) => ticketStates(state)['acme/widgets#11'] === 'skipped');
    expect(ticketStates(state)).toEqual({ 'acme/widgets#11': 'skipped', 'acme/widgets#12': 'waiting', 'acme/widgets#15': 'launched' });

    // Reading the set again, at the next poll, launches nothing more.
    factory.clock.advance(15 * 60_000);
    await operator.send({ type: 'daemon.status' });
    state = await tui.until((state) => !state.tasks.T1?.ticketSet?.problem);
    expect(ticketTasks(state)).toEqual({ 'acme/widgets#11': 'T2', 'acme/widgets#15': 'T3' });
    expect(requests(state)).toEqual([]);
  });
});

describe('only skipped tickets left', () => {
  // T2 cancelled, and T3's PR merged: nothing more can be launched, and nothing is in flight.
  async function stalled(): Promise<Factory & { asked: FactoryState }> {
    const spec = await launched();
    const { operator, tui } = spec;
    await operator.send({ type: 'cancel', taskId: 'T2', branch: 'discard' });
    await tui.until((state) => ticketStates(state)['acme/widgets#11'] === 'skipped');
    const pr = await toReview(spec, 'T3');
    await merge(spec, pr);
    const asked = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    return { ...spec, asked };
  }

  test('the spec task asks the operator to relaunch a skipped ticket, end leaving the spec open, or close the spec anyway', async () => {
    const { asked } = await stalled();

    expect(requests(asked)).toMatchObject([
      {
        taskId: 'T1',
        attention: 'stage-blocked',
        skipped: ['acme/widgets#11'],
        reason:
          'implement can launch no more tickets: acme/widgets#11 was skipped when its ticket task was cancelled, and acme/widgets#12 waits on it. ' +
          'Relaunch a skipped ticket, end leaving acme/widgets#10 open, or close it anyway.',
      },
    ]);
  });

  test('a plain answer chooses none of them, and is refused', async () => {
    const { operator } = await stalled();

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({
      ok: false,
      reason: 'T1 can launch no more tickets: relaunch a skipped ticket, end leaving its spec open, or close it anyway.',
    });
    expect(await operator.send({ type: 'answer', taskId: 'T1', relaunch: 'acme/widgets#12' })).toEqual({ ok: false, reason: 'acme/widgets#12 isn’t a skipped ticket of T1.' });
  });

  test('Relaunch launches a new ticket task on the chosen ticket', async () => {
    const { factory, operator, tui } = await stalled();

    expect(await operator.send({ type: 'answer', taskId: 'T1', relaunch: 'acme/widgets#11' })).toEqual({ ok: true });

    const state = await tui.until((state) => !!state.tasks.T4?.liveRunId);
    expect(state.tasks.T4).toMatchObject({ kind: 'ticket', ticket: 'acme/widgets#11', specTask: 'T1' });
    expect(ticketStates(state)['acme/widgets#11']).toBe('launched');
    expect(state.tasks.T1?.label).not.toBe('Needs you');
    expect(requests(state)).toEqual([]);
    expect(factory.executor.started.at(-1)?.firstMessage?.split('\n')[0]).toBe('/factory:implement acme/widgets#11');
  });

  test('End ends the spec task, Done, leaving the spec and its skipped ticket open', async () => {
    const { factory, operator, tui } = await stalled();

    expect(await operator.send({ type: 'answer', taskId: 'T1', end: 'spec-open' })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(requests(state)).toEqual([]);
    expect(factory.github.issueState(SPEC).open).toBe(true);
    expect(factory.github.issueState('acme/widgets#11').open).toBe(true);
    expect(factory.github.writes.filter(({ ref }) => ref === SPEC)).toEqual([]);
  });

  test('Close anyway closes the spec with a comment naming the skipped tickets left open, and the spec task is Done', async () => {
    const { factory, operator, tui } = await stalled();

    expect(await operator.send({ type: 'answer', taskId: 'T1', end: 'close-spec' })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Done' && state.tasks.T1.cleanup === null);
    expect(factory.github.issueState(SPEC)).toMatchObject({ open: false, stateReason: 'completed' });
    const close = factory.github.writes.find(({ ref }) => ref === SPEC)!;
    expect(close.comment).toMatch(/^The operator closed this spec with tickets left open, so the agents factory’s task T1 \(.*\) closes it:/);
    expect(close.comment).toContain('- acme/widgets#11, A login form: skipped, left open');
    expect(close.comment).toContain('- acme/widgets#12, Remember me: left open');
    expect(close.comment).toMatch(/- acme\/widgets#15, Sign out: merged in https:\/\/github.com\/acme\/widgets\/pull\/\d+/);
    expect(factory.github.issueState('acme/widgets#11').open).toBe(true);
  });
});

describe('cancelling the spec task', () => {
  test('cancels every unmerged ticket task, closing their PRs, and leaves the merged ones, their tickets and the spec as they are', async () => {
    const spec = await launched();
    const { factory, operator, tui } = spec;
    const merged = await toReview(spec, 'T2');
    await merge(spec, merged);
    await tui.until((state) => state.tasks.T2?.label === 'Done' && !!state.tasks.T4?.liveRunId);
    const open = await toReview(spec, 'T3');
    const closes = factory.github.writes.length;

    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' })).toEqual({ ok: true });

    const state = await tui.until((state) => ['T1', 'T3', 'T4'].every((id) => state.tasks[id]?.label === 'Cancelled' && state.tasks[id].cleanup === null));
    expect(state.tasks.T2?.label).toBe('Done');
    expect(factory.github.pullRequests.find(({ number }) => number === open)?.state).toBe('closed');
    expect(factory.github.pullRequests.find(({ number }) => number === merged)?.state).toBe('merged');
    expect(factory.github.issueState('acme/widgets#11').open).toBe(false);
    expect(factory.github.issueState(SPEC).open).toBe(true);
    expect(factory.github.writes).toHaveLength(closes);
    expect(Object.values(state.runs).filter(({ status }) => status !== 'ended')).toEqual([]);
    expect(await factory.git.worktrees(clone)).toEqual([]);
  });

  test('asks Keep branch or Discard work once for the lot when any of them holds unique commits; Keep branch keeps every branch', async () => {
    const { factory, operator, tui } = await launched();
    const before = tui.state();
    for (const id of ['T2', 'T3']) {
      factory.git.editFile(factory.sandbox.workdirOf(id), `src/${id}.ts`);
      factory.git.commitAll(factory.sandbox.workdirOf(id));
    }

    const asked = await operator.send({ type: 'cancel', taskId: 'T1' });

    expect(asked).toMatchObject({
      ok: false,
      choose: [
        { label: 'Keep branch', command: { type: 'cancel', taskId: 'T1', branch: 'keep' } },
        { label: 'Discard work', command: { type: 'cancel', taskId: 'T1', branch: 'discard' } },
      ],
    });
    const reason = !asked.ok ? asked.reason : '';
    expect(reason).toContain(`${before.tasks.T2!.branch} has 1 commit that exists nowhere else.`);
    expect(reason).toContain(`${before.tasks.T3!.branch} has 1 commit that exists nowhere else.`);
    expect(tui.state().tasks.T2?.label).toBe('Running');

    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'keep' })).toEqual({ ok: true });

    await tui.until((state) => ['T1', 'T2', 'T3'].every((id) => state.tasks[id]?.label === 'Cancelled' && state.tasks[id].cleanup === null));
    expect(await factory.git.worktrees(clone)).toEqual([]);
    for (const id of ['T1', 'T2', 'T3']) expect(factory.git.branchTip(clone, before.tasks[id]!.branch!)).not.toBeNull();
    expect(await factory.git.unpushed(clone, before.tasks.T2!.branch!)).toHaveLength(1);
  });

  test('a crash in the middle of the cascade finishes on the next start', async () => {
    const { factory, operator } = await launched();
    const crashed = factory.crashAt('git', 'removeWorktree', 'after');
    void operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' });
    await crashed;
    await factory.crash();

    await factory.startDaemon();
    const restarted = watch(await factory.attach());

    const state = await restarted.until((state) => ['T1', 'T2', 'T3'].every((id) => state.tasks[id]?.label === 'Cancelled' && state.tasks[id].cleanup === null));
    expect(Object.keys(state.tasks)).toEqual(['T1', 'T2', 'T3']);
    expect(await factory.git.worktrees(clone)).toEqual([]);
  });
});
