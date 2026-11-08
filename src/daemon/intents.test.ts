// Seam 1: the intent journal (ADR 0003). An operator verb with side effects
// outside the store first journals an intent, then takes idempotent steps.
// A crash after any step leaves the task fully moved or fully back once the
// next daemon has replayed its unfinished intents, before it reconciles runs,
// and the Factory recovered report lists what it replayed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';
import { relayHook } from '../hooks/relay.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
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

// The daemon crashes once the crash point armed is reached, and a new one starts.
async function crashAndRestart(factory: TestFactory, crashed: Promise<void>): Promise<{ operator: FactoryConnection; tui: Watched }> {
  await crashed;
  await factory.crash();
  await factory.startDaemon();
  const operator = await factory.attach();
  return { operator, tui: watch(operator) };
}

type Attention = Extract<FactoryState['attentionQueue'][number], { kind: 'attention' }>;
const recoveryReport = (state: FactoryState) =>
  state.attentionQueue.find((item): item is Attention => item.kind === 'attention' && item.attention === 'recovery-report');

const brief = {
  goal: 'Failed webhook deliveries are retried instead of dropped.',
  decided: ['Retry 5xx and timeouts only; never 4xx.'],
  doneWhen: ['A 503 is retried 5 times with backoff.'],
  outOfScope: [],
  links: [],
};

// T1 launched on main-flow, grilled on R1, which wrote GLOSSARY.md, with
// the handoff sheet open on the brief R1 wrote, on the operator's turn.
async function briefed() {
  const { factory, operator, tui } = await attached();
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Retry failed webhook deliveries.' });
  if (!launched.ok) throw new Error(launched.reason);
  await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
  const { sessionId, cwd } = factory.executor.started[0]!;
  factory.git.editFile(cwd!, 'GLOSSARY.md');
  const event = { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd!, 'GLOSSARY.md') } };
  await relayHook(JSON.stringify({ ...event, tool_response: '' }), factory.paths);
  await tui.until((state) => Object.keys(state.artifacts).length > 0);
  factory.executor.report('R1', { type: 'turnEnded' });
  await operator.send({ type: 'openHandoff', taskId: 'T1' });
  factory.executor.report('R1', { type: 'briefWritten', brief });
  factory.executor.report('R1', { type: 'turnEnded' });
  const sheet = await tui.until((state) => state.tasks.T1?.handoff?.brief != null && state.runs.R1?.turn === 'operator');
  return { factory, operator, tui, sheet, cwd: cwd! };
}

// The sheet as the operator confirms it, with an item they added.
const confirmed = (state: FactoryState) => {
  const { continueAs, autonomy, tier, maxTurns } = state.tasks.T1!.handoff!;
  const edited = { ...brief, outOfScope: ['The webhook signing code.'] };
  return { type: 'handoff', taskId: 'T1', brief: edited, continueAs, autonomy, tier, maxTurns: maxTurns + 1 } as const;
};

describe('a handoff', () => {
  test.each(['before', 'after'] as const)('confirmed, then crashed %s its commit, is finished on the next start', async (when) => {
    const { factory, operator, sheet, cwd } = await briefed();
    const crashed = factory.crashAt('git', 'commit', when);
    void operator.send(confirmed(sheet));

    const { tui } = await crashAndRestart(factory, crashed);

    const state = await tui.until((state) => state.runs.R2?.status === 'active');
    expect(factory.git.commits.filter((commit) => commit.worktreePath === cwd)).toEqual([
      { worktreePath: cwd, paths: ['GLOSSARY.md'], message: `Handoff of T1: ${state.tasks.T1!.title}` },
    ]);
    expect(state.runs.R1).toMatchObject({ mode: 'HITL', status: 'ended', outcome: 'handed off' });
    expect(state.runs.R2).toMatchObject({ mode: 'AFK', maxTurns: sheet.tasks.T1!.handoff!.maxTurns + 1 });
    expect(state.tasks.T1).toMatchObject({ mode: 'AFK', label: 'Running', handoff: null });
    expect(state.tasks.T1!.goal).toContain('The webhook signing code.');
    expect(Object.values(state.artifacts).map((artifact) => artifact.kind === 'file' && artifact.committed)).toEqual([true]);
    expect(recoveryReport(state)).toMatchObject({
      reason: 'The factory restarted after it stopped uncleanly. Replayed T1’s handoff.',
      recovery: { requeued: [], parked: [], failed: [], replayed: [{ taskId: 'T1', verb: 'handoff', outcome: 'finished' }] },
    });
  });

  test('unconfirmed at a crash, its sheet is saved as a draft: the conversation parks, and reopening the sheet shows it pre-filled', async () => {
    const { factory, sheet, cwd } = await briefed();
    const { maxTurns } = sheet.tasks.T1!.handoff!;

    const { operator, tui } = await crashAndRestart(factory, Promise.resolve());

    const parked = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(parked.runs.R1).toMatchObject({ outcome: 'parked' });
    expect(parked.tasks.T1).toMatchObject({ mode: 'HITL', label: 'Ready for you', handoff: null });
    expect(recoveryReport(parked)?.recovery).toEqual({ requeued: [], parked: [{ taskId: 'T1', runId: 'R1' }], failed: [], replayed: [] });

    expect(await operator.send({ type: 'openHandoff', taskId: 'T1' })).toEqual({ ok: true });
    const reopened = await tui.until((state) => state.tasks.T1?.handoff != null);
    expect(reopened.tasks.T1!.handoff).toMatchObject({ brief, maxTurns, readiness: { blockers: [], toCommit: ['GLOSSARY.md'] } });
    // The brief is there: no run is resumed to write it again.
    expect(factory.executor.started.map(({ runId }) => runId)).toEqual(['R1']);

    // Confirmed now, it hands off as any sheet does.
    expect(await operator.send(confirmed(reopened))).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.mode === 'AFK' && state.runs.R2?.status === 'active');
    expect(factory.git.commits.filter((commit) => commit.worktreePath === cwd)).toHaveLength(1);
  });
});

const clone = resolve('/clones/widgets');
const branch = 'factory/T1-add-a-logout-button';

// T1 launched from a one-stage AFK preset at `autonomy`, its run R1 live.
async function running(autonomy: 'L1' | 'L2' = 'L1') {
  const { factory, operator, tui } = await attached();
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(
    join(factory.paths.presetsDir, 'unattended.preset.yaml'),
    'stages:\n  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", exit: run-completed }\n',
  );
  if (autonomy === 'L2') await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-test');
  const launched = await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: 'Add a logout button.', autonomy });
  if (!launched.ok) throw new Error(launched.reason);
  const state = await tui.until((state) => state.runs.R1?.status === 'active');
  return { factory, operator, tui, worktree: state.tasks.T1!.worktree! };
}

describe('a takeover', () => {
  // T1 at L2, its run R1 live in its container, which holds a commit the host lacks.
  async function inContainer() {
    const { factory, operator, tui } = await attached();
    await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'oauth-token');
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: '#39', autonomy: 'L2' });
    await tui.until((state) => state.runs.R1?.status === 'active');
    await vi.waitFor(() => expect(factory.sandbox.prepared).toHaveLength(1));
    const workdir = factory.sandbox.workdirOf('T1');
    factory.git.editFile(workdir, 'src/login.ts', 'from the container');
    factory.git.commitAll(workdir);
    const { branch } = factory.sandbox.prepared[0]!;
    return { factory, operator, branch, tip: factory.git.branchTip(factory.sandbox.clonePathOf('T1'), branch)! };
  }

  test.each(['restart', 'bringOut'] as const)('of an L2 task, crashed before its container’s %s, ends the turn left there and brings its commits out on the next start', async (step) => {
    const { factory, operator, branch, tip } = await inContainer();
    const crashed = factory.crashAt('sandbox', step, 'before');
    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    await crashed;
    await factory.crash();
    factory.sandbox.calls.length = 0;
    await factory.startDaemon();
    const tui = watch(await factory.attach());

    const state = await tui.until((state) => !!recoveryReport(state));
    expect(factory.sandbox.calls.slice(0, 2)).toEqual(['restart T1', 'bringOut T1']);
    expect(factory.git.branchTip(clone, branch)).toBe(tip);
    expect(state.runs.R1).toMatchObject({ outcome: 'taken over' });
    expect(state.runs.R2).toMatchObject({ mode: 'HITL', outcome: 'parked' });
    expect(state.tasks.T1).toMatchObject({ mode: 'HITL', label: 'Ready for you' });
    expect(recoveryReport(state)!.recovery).toEqual({
      requeued: [],
      parked: [{ taskId: 'T1', runId: 'R2' }],
      failed: [],
      replayed: [{ taskId: 'T1', verb: 'takeover', outcome: 'finished' }],
    });
  });

  test('of an L2 task that finished before a crash leaves nothing to replay', async () => {
    const { factory, operator, branch, tip } = await inContainer();
    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(factory.sandbox.calls).toContain('stop T1'));
    expect(factory.git.branchTip(clone, branch)).toBe(tip);

    const { tui } = await crashAndRestart(factory, Promise.resolve());

    const state = await tui.until((state) => state.runs.R2?.status === 'ended');
    expect(recoveryReport(state)!.recovery!.replayed).toEqual([]);
  });

  test('of an L1 task, crashed once taken over, stays taken over: its conversation parks', async () => {
    const { factory, operator } = await running();
    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    const { tui } = await crashAndRestart(factory, Promise.resolve());

    const state = await tui.until((state) => state.runs.R2?.status === 'ended');
    expect(state.runs.R1).toMatchObject({ outcome: 'taken over' });
    expect(state.runs.R2).toMatchObject({ mode: 'HITL', outcome: 'parked' });
    expect(state.tasks.T1).toMatchObject({ mode: 'HITL', label: 'Ready for you' });
    expect(recoveryReport(state)!.recovery!.replayed).toEqual([]);
  });
});

describe('a stage advance', () => {
  test('is one write to the store: crashed once advanced, the task is at its next stage, its conversation parked there', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.runs.R2?.status === 'active');

    const restarted = await crashAndRestart(factory, Promise.resolve());

    const state = await restarted.tui.until((state) => state.runs.R2?.status === 'ended');
    expect(state.runs.R1).toMatchObject({ outcome: 'completed', stage: 'grill' });
    expect(state.runs.R2).toMatchObject({ outcome: 'parked', stage: 'spec' });
    expect(state.tasks.T1).toMatchObject({ stage: 'spec', label: 'Ready for you' });
    expect(recoveryReport(state)!.recovery!.replayed).toEqual([]);
  });
});

describe('a cancel cascade', () => {
  test.each(['removeWorktree', 'deleteBranch'] as const)('crashed before its cleanup’s %s finishes the cleanup on the next start', async (step) => {
    const { factory, operator } = await running();
    const crashed = factory.crashAt('git', step, 'before');
    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'discard' })).toEqual({ ok: true });

    const { tui } = await crashAndRestart(factory, crashed);

    const state = await tui.until((state) => state.tasks.T1?.cleanup === null && state.tasks.T1.transcripts !== null);
    expect(state.tasks.T1).toMatchObject({ label: 'Cancelled' });
    expect(await factory.git.worktrees(clone)).toEqual([]);
    await expect(factory.git.isMerged(clone, branch, 'origin/main')).rejects.toThrow();
    expect(state.attentionQueue.map((item) => (item.kind === 'attention' ? item.attention : item.kind))).toEqual(['recovery-report']);
    expect(recoveryReport(state)).toMatchObject({
      reason: 'The factory restarted after it stopped uncleanly. Replayed T1’s cleanup.',
      recovery: { replayed: [{ taskId: 'T1', verb: 'cleanup', outcome: 'resumed' }] },
    });
  });

  test('crashed before it reopened the tickets the task closed reopens them on the next start', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.addIssue('acme/widgets#10');
    factory.github.addIssue('acme/widgets#11', { parent: 'acme/widgets#10', labels: ['ready-for-agent'] });
    factory.github.addIssue('acme/widgets#12', { parent: 'acme/widgets#10', labels: ['ready-for-agent'] });
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'main-flow', stage: 'implement', issues: ['#10'] });
    const { worktree } = (await tui.until((state) => state.tasks.T1?.liveRunId === 'R1')).tasks.T1!;
    factory.git.editFile(worktree!, 'src/logout.ts');
    factory.git.commitAll(worktree!);
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(factory.github.issueState('acme/widgets#11')).toMatchObject({ open: false });
    const crashed = factory.crashAt('github', 'reopenIssue', 'before');
    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'keep' })).toEqual({ ok: true });

    const restarted = await crashAndRestart(factory, crashed);

    const state = await restarted.tui.until((state) => state.tasks.T1?.reopening === null && state.tasks.T1.cleanup === null);
    expect(factory.github.issueState('acme/widgets#11')).toMatchObject({ open: true, stateReason: 'reopened' });
    expect(recoveryReport(state)!.recovery!.replayed).toEqual(expect.arrayContaining([{ taskId: 'T1', verb: 'cancel', outcome: 'resumed' }]));
  });
});

describe('a spawn', () => {
  test.each(['before', 'after'] as const)('crashed %s the child’s worktree is cut, is finished on the next start, with one child on one branch', async (when) => {
    const { factory } = await running();
    const crashed = factory.crashAt('git', 'addWorktree', when);
    void factory.executor.delegate('R1', { type: 'spawnChild', toolUseId: 'toolu_1', goal: 'Survey how the app signs users out.', await: false });

    const { tui } = await crashAndRestart(factory, crashed);

    const state = await tui.until((state) => !!state.tasks.T1?.liveRunId && !!state.tasks.T2?.liveRunId);
    expect(Object.keys(state.tasks)).toEqual(['T1', 'T2']);
    expect(state.tasks.T2).toMatchObject({ parent: 'T1', branch: `${branch}--c1`, child: { awaited: false } });
    expect((await factory.git.worktrees(clone)).filter((worktree) => worktree.branch === `${branch}--c1`)).toHaveLength(1);
    expect(state.runs.R1).toMatchObject({ outcome: 'interrupted', interruption: 'unclean' });
    expect(recoveryReport(state)).toMatchObject({
      reason: 'The factory restarted after it stopped uncleanly. Replayed T1’s spawn. Requeued T1 (R1).',
      recovery: { replayed: [{ taskId: 'T1', verb: 'spawn', outcome: 'finished' }] },
    });
  });

  test('whose worktree can’t be cut on the next start is rolled back, touching nothing it didn’t cut', async () => {
    const { factory } = await running();
    const crashed = factory.crashAt('git', 'addWorktree', 'before');
    void factory.executor.delegate('R1', { type: 'spawnChild', toolUseId: 'toolu_1', goal: 'Survey how the app signs users out.', await: false });
    await crashed;
    await factory.crash();
    // Meanwhile something else took the child's branch.
    const elsewhere = resolve('/elsewhere/c1');
    await factory.git.addWorktree(clone, { path: elsewhere, branch: `${branch}--c1`, startPoint: branch });

    await factory.startDaemon();
    const tui = watch(await factory.attach());

    const state = await tui.until((state) => state.runs.R2?.status === 'active');
    expect(Object.keys(state.tasks)).toEqual(['T1']);
    expect((await factory.git.worktrees(clone)).filter((worktree) => worktree.branch === `${branch}--c1`)).toMatchObject([{ path: elsewhere }]);
    expect(recoveryReport(state)).toMatchObject({
      reason: 'The factory restarted after it stopped uncleanly. Replayed T1’s spawn (rolled back). Requeued T1 (R1).',
      recovery: { replayed: [{ taskId: 'T1', verb: 'spawn', outcome: 'rolled back' }] },
    });
  });
});
