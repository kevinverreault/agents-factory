// Seam 1: runs survive the factory stopping (ADR 0002, ADR 0003). A graceful
// stop requeues active AFK runs as `interrupted` and parks the rest; a start
// without the clean-shutdown marker reconciles the same way, flagged unclean,
// guards against crash loops and reports what it did in Needs you.
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

const clone = resolve('/clones/widgets');

// What a daemon before this one left that no task has: a worktree under the
// worktree root, and a running container of a task the store never heard of.
async function debris(factory: TestFactory): Promise<{ path: string; container: string }> {
  const path = join(factory.paths.worktreeRoot, 'acme-widgets', 'T7');
  const branch = 'factory/T7-lost-work';
  await factory.git.addWorktree(clone, { path, branch, startPoint: 'origin/main' });
  factory.sandbox.leave({ taskId: 'T9', clonePath: clone, branch, branches: [], plugin: null, runDir: '/run', sessionsDir: '/sessions', egress: [] }, 'running');
  return { path, container: 'T9' };
}

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

const afk = (title: string) => ({ type: 'createTask', repo: 'acme/widgets', title, mode: 'AFK', submit: true }) as const;
const hitl = (title: string) => ({ type: 'createTask', repo: 'acme/widgets', title, mode: 'HITL', submit: true }) as const;

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

const RECOVERY_NOTE =
  'The factory restarted mid-turn. Your last turn may be incomplete. Check `git status` and re-verify before continuing.';

// T1's AFK run R1 active, T2's R2 suspended on a question, and T3's HITL
// run R3 in conversation.
async function oneOfEach(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const attachedFactory = await attached();
  const { factory, operator, tui } = attachedFactory;
  await operator.send({ type: 'setSlotCap', cap: 3 });
  await operator.send(afk('Fix the login bug'));
  await operator.send(afk('Fix the flaky test'));
  await tui.until((state) => state.runs.R2?.status === 'active');
  factory.executor.report('R2', { type: 'attentionRaised', kind: 'question', question });
  await operator.send(hitl('Grill the billing plan'));
  expect(await operator.send({ type: 'open', taskId: 'T3' })).toEqual({ ok: true });
  await tui.until((state) => state.runs.R2?.status === 'suspended' && state.runs.R3?.status === 'active');
  return attachedFactory;
}

describe('a graceful stop', () => {
  test('`daemon stop` requeues active AFK runs as interrupted and parks suspended and HITL runs', async () => {
    const { factory, operator } = await oneOfEach();

    expect(await operator.send({ type: 'daemon.stop' })).toEqual({ ok: true });
    await factory.daemon().stopped;
    expect([...factory.executor.stopped].sort()).toEqual(['R1', 'R2', 'R3']);
    await factory.startDaemon();
    const tui = watch(await factory.attach());

    const state = await tui.until((state) => state.runs.R4?.status === 'active');
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'interrupted', interruption: 'graceful' });
    expect(state.runs.R2).toMatchObject({ status: 'ended', outcome: 'parked', interruption: null });
    expect(state.runs.R3).toMatchObject({ status: 'ended', outcome: 'parked', interruption: null });
    expect(state.tasks.T1).toMatchObject({ label: 'Running', liveRunId: 'R4' });
    expect(state.tasks.T2).toMatchObject({ label: 'Needs you', liveRunId: null });
    expect(state.tasks.T3).toMatchObject({ label: 'Ready for you', liveRunId: null });
    // A graceful stop reports nothing: the operator stopped it.
    expect(state.attentionQueue.map((item) => item.kind === 'attention' ? item.attention : item.kind)).toEqual(['question', 'ready']);
  });

  test('the run after an interrupted one resumes its session and opens on the recovery note', async () => {
    const { factory } = await oneOfEach();

    await factory.restart();
    const tui = watch(await factory.attach());
    await tui.until((state) => state.runs.R4?.status === 'active');

    expect(factory.executor.started.at(-1)).toMatchObject({ runId: 'R4', taskId: 'T1', resumesSession: true, firstMessage: RECOVERY_NOTE });
  });

  test('a stop starts no new run: a queued AFK task waits for the next daemon', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Add dark mode'));
    await tui.until((state) => state.runs.R1?.status === 'active' && state.tasks.T2?.label === 'Queued');

    await factory.daemon().stop();

    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1']);
  });
});

describe('a start after a crash', () => {
  test('reconciles like a graceful stop, flagged unclean: active AFK runs requeue as interrupted, the rest park', async () => {
    const { factory } = await oneOfEach();

    await factory.crash();
    await factory.startDaemon();
    const tui = watch(await factory.attach());

    const state = await tui.until((state) => state.runs.R4?.status === 'active');
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'interrupted', interruption: 'unclean' });
    expect(state.runs.R2).toMatchObject({ status: 'ended', outcome: 'parked' });
    expect(state.runs.R3).toMatchObject({ status: 'ended', outcome: 'parked' });
    expect(state.tasks.T1).toMatchObject({ label: 'Running', liveRunId: 'R4' });
    expect(state.tasks.T2).toMatchObject({ label: 'Needs you', liveRunId: null });
    expect(state.tasks.T3).toMatchObject({ label: 'Ready for you', liveRunId: null });
    expect(factory.executor.started.at(-1)).toMatchObject({ runId: 'R4', resumesSession: true, firstMessage: RECOVERY_NOTE });
  });

  test('a start after a graceful stop finds its marker, so a crash after it is still unclean', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');

    await factory.restart();
    await watch(await factory.attach()).until((state) => state.runs.R2?.status === 'active');
    await factory.crash();
    await factory.startDaemon();

    const state = await watch(await factory.attach()).until((state) => state.runs.R3?.status === 'active');
    expect(state.runs.R1).toMatchObject({ outcome: 'interrupted', interruption: 'graceful' });
    expect(state.runs.R2).toMatchObject({ outcome: 'interrupted', interruption: 'unclean' });
  });
});

describe('the crash-loop guard', () => {
  test('a task whose run was active at two unclean starts in a row ends its run failed, with a failure attention request', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');
    await factory.crash();
    await factory.startDaemon();
    await watch(await factory.attach()).until((state) => state.runs.R2?.status === 'active');

    await factory.crash();
    await factory.startDaemon();
    const state = await watch(await factory.attach()).until((state) => state.runs.R2?.status === 'ended');

    expect(state.runs.R2).toMatchObject({ outcome: 'failed' });
    expect(state.runs.R3).toBeUndefined();
    expect(state.tasks.T1).toMatchObject({ label: 'Needs you', liveRunId: null });
    expect(state.attentionQueue.filter((item) => item.taskId === 'T1')).toMatchObject([
      {
        taskId: 'T1',
        attention: 'failure',
        reason:
          'R2 was active when the factory stopped uncleanly twice in a row, so the factory didn’t requeue it again: it may be what crashes the factory.',
      },
    ]);
  });

  test('a run that ends normally in between resets the count', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');
    await factory.crash();
    await factory.startDaemon();
    const operatorAgain = await factory.attach();
    await watch(operatorAgain).until((state) => state.runs.R2?.status === 'active');
    factory.executor.report('R2', { type: 'runFailed', reason: 'The agent hit max turns.' });
    await settled(operatorAgain);
    expect(await operatorAgain.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });
    await watch(operatorAgain).until((state) => state.runs.R3?.status === 'active');

    await factory.crash();
    await factory.startDaemon();

    const state = await watch(await factory.attach()).until((state) => state.runs.R4?.status === 'active');
    expect(state.runs.R3).toMatchObject({ outcome: 'interrupted', interruption: 'unclean' });
  });

  test('an unclean start that finds the task queued, not active, breaks the row', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');
    await operator.send({ ...afk('Fix the outage'), priority: 'urgent' });
    await settled(operator);
    // T1 requeues, but urgent T2 takes the one slot.
    await factory.crash();
    await factory.startDaemon();
    await watch(await factory.attach()).until((state) => state.runs.R2?.taskId === 'T2' && state.tasks.T1?.label === 'Queued');
    // Only T2 is active this time, and it takes the slot again.
    await factory.crash();
    await factory.startDaemon();
    const operatorAgain = await factory.attach();
    await watch(operatorAgain).until((state) => state.runs.R3?.taskId === 'T2');
    factory.executor.report('R3', { type: 'runCompleted' });
    await watch(operatorAgain).until((state) => state.runs.R4?.taskId === 'T1' && state.runs.R4.status === 'active');

    await factory.crash();
    await factory.startDaemon();

    const state = await watch(await factory.attach()).until((state) => state.runs.R4?.status === 'ended');
    expect(state.runs.R4).toMatchObject({ outcome: 'interrupted', interruption: 'unclean' });
    expect(state.tasks.T1).toMatchObject({ label: 'Running', liveRunId: 'R5' });
  });

  test('a graceful stop in between neither counts nor resets', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');
    await factory.crash();
    await factory.startDaemon();
    await watch(await factory.attach()).until((state) => state.runs.R2?.status === 'active');
    await factory.restart();
    await watch(await factory.attach()).until((state) => state.runs.R3?.status === 'active');

    await factory.crash();
    await factory.startDaemon();

    const state = await watch(await factory.attach()).until((state) => state.runs.R3?.status === 'ended');
    expect(state.runs.R3).toMatchObject({ outcome: 'failed' });
  });
});

describe('the Factory recovered report', () => {
  test('after an unclean start, one dismissable entry in Needs you lists what was requeued, parked and failed', async () => {
    const { factory } = await oneOfEach();

    await factory.crash();
    await factory.startDaemon();
    const operator = await factory.attach();
    const tui = watch(operator);

    const state = await tui.until((state) => state.attentionQueue.some((item) => item.kind === 'attention' && item.attention === 'recovery-report'));
    const reports = state.attentionQueue.filter((item) => item.kind === 'attention' && item.attention === 'recovery-report');
    expect(reports).toEqual([
      {
        kind: 'attention',
        taskId: null,
        repo: null,
        requestId: expect.any(String),
        attention: 'recovery-report',
        holdsRun: false,
        reason: 'The factory restarted after it stopped uncleanly. Requeued T1 (R1). Parked T2 (R2), T3 (R3).',
        question: null,
        permission: null,
        deniedHosts: null,
        recovery: {
          requeued: [{ taskId: 'T1', runId: 'R1' }],
          parked: [
            { taskId: 'T2', runId: 'R2' },
            { taskId: 'T3', runId: 'R3' },
          ],
          failed: [],
          replayed: [],
        },
      },
    ]);

    const { requestId } = reports[0] as { requestId: string };
    expect(await operator.send({ type: 'dismiss', requestId })).toEqual({ ok: true });
    const dismissed = await tui.until((state) => !state.attentionQueue.some((item) => item.kind === 'attention' && item.attention === 'recovery-report'));
    expect(dismissed.attentionQueue.map((item) => item.taskId)).toEqual(['T2', 'T3']);
    expect(await operator.send({ type: 'dismiss', requestId })).toEqual({ ok: false, reason: 'That report is already dismissed.' });
  });

  test('a run failed by the crash-loop guard is listed as failed, and a second unclean start adds to the open report', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');
    await factory.crash();
    await factory.startDaemon();
    await watch(await factory.attach()).until((state) => state.runs.R2?.status === 'active');

    await factory.crash();
    await factory.startDaemon();

    const state = await watch(await factory.attach()).until((state) => state.runs.R2?.outcome === 'failed');
    expect(state.attentionQueue.filter((item) => item.kind === 'attention' && item.attention === 'recovery-report')).toMatchObject([
      {
        reason: 'The factory restarted after it stopped uncleanly. Requeued T1 (R1). Failed T1 (R2): active at two unclean starts in a row.',
        recovery: { requeued: [{ taskId: 'T1', runId: 'R1' }], parked: [], failed: [{ taskId: 'T1', runId: 'R2' }] },
      },
    ]);
  });

  test('an unclean start stops a leftover container and lists it with a leftover worktree, deleting neither', async () => {
    const { factory } = await attached();
    const { path, container } = await debris(factory);

    await factory.crash();
    await factory.startDaemon();
    const tui = watch(await factory.attach());

    const state = await tui.until((state) => state.attentionQueue.some((item) => item.kind === 'attention' && item.attention === 'recovery-report'));
    expect(state.attentionQueue).toMatchObject([
      {
        attention: 'recovery-report',
        reason: `The factory restarted after it stopped uncleanly. Found what no live task has: ${container}’s container and the worktree at ${path}. It deleted none of them: :gc lists them to delete.`,
        recovery: { requeued: [], parked: [], failed: [], found: { containers: [container], worktrees: [path] } },
      },
    ]);
    await expect.poll(() => factory.sandbox.state(container)).toBe('stopped');
    expect((await factory.git.worktrees(clone)).map((worktree) => worktree.path)).toEqual([path]);
  });

  test('a graceful restart doesn’t report leftovers', async () => {
    const { factory } = await attached();
    await debris(factory);

    await factory.restart();
    const operator = await factory.attach();
    const tui = watch(operator);
    await settled(operator);

    expect(tui.state().attentionQueue).toEqual([]);
  });

  test('an unclean start with nothing to reconcile reports nothing', async () => {
    const { factory } = await attached();

    await factory.crash();
    await factory.startDaemon();
    const operator = await factory.attach();
    const tui = watch(operator);
    await settled(operator);

    expect(tui.state().attentionQueue).toEqual([]);
  });

  test('only the Factory recovered report can be dismissed', async () => {
    const { factory, operator } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.report('R1', { type: 'runFailed', reason: 'The agent hit max turns.' });
    await settled(operator);

    expect(await operator.send({ type: 'dismiss', requestId: 'A1' })).toEqual({ ok: false, reason: 'Only the Factory recovered report can be dismissed.' });
    expect(await operator.send({ type: 'dismiss', requestId: 'A9' })).toEqual({ ok: false, reason: 'There is no attention request A9.' });
  });
});

describe('restart when idle', () => {
  test('the daemon starts no new run, and stops gracefully once no run is active', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Add dark mode'));
    await tui.until((state) => state.runs.R1?.status === 'active' && state.tasks.T2?.label === 'Queued');
    let stopped = false;
    void factory.daemon().stopped.then(() => (stopped = true));

    expect(await operator.send({ type: 'daemon.restartWhenIdle' })).toEqual({ ok: true, value: { activeRuns: 1 } });
    expect(await operator.send(hitl('Grill the billing plan'))).toMatchObject({ ok: true });
    expect(await operator.send({ type: 'open', taskId: 'T3' })).toEqual({
      ok: false,
      reason: 'The daemon restarts once no run is active, so it starts no new run.',
    });
    expect(await operator.send({ type: 'daemon.status' })).toMatchObject({ ok: true, value: { restartsWhenIdle: true } });
    factory.executor.report('R1', { type: 'runCompleted' });
    await factory.daemon().stopped;

    expect(stopped).toBe(true);
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1']);
    await factory.startDaemon();
    const state = await watch(await factory.attach()).until((state) => state.runs.R2?.status === 'active');
    expect(state.tasks.T2).toMatchObject({ label: 'Running', liveRunId: 'R2' });
    // It stopped gracefully: nothing to report.
    expect(state.attentionQueue).toEqual([
      { kind: 'ready', taskId: 'T3' },
      { kind: 'review', taskId: 'T1' },
    ]);
  });

  test('with no run active, the daemon stops at once, parking a suspended run', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.report('R1', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    expect(await operator.send({ type: 'daemon.restartWhenIdle' })).toEqual({ ok: true, value: { activeRuns: 0 } });
    await factory.daemon().stopped;

    await factory.startDaemon();
    const state = await watch(await factory.attach()).until(() => true);
    expect(state.runs.R1).toMatchObject({ status: 'ended', outcome: 'parked' });
  });
});
