// Seam 1: L2 runs in their task's container (ADR 0007, ADR 0011), through the
// client protocol. An L2 AFK run executes in the task's container with the
// subscription token and no write credential, its commits land on the host
// task branch through a bundle, and the container stops whenever the task
// has no live run, restarts before a requeued run after a stop or a crash,
// and goes once the task ends, after a final bundle.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { BUILT_IN_EGRESS } from '../sandbox/sandbox.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

async function attached({ token = 'oauth-token' }: { token?: string | null } = {}): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  if (token) await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, token);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const implementAtL2 = (issue: string): LaunchCommand => ({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: issue, autonomy: 'L2' });
const clone = resolve('/clones/widgets');

// The task's run that started `n`th, once the executor has it.
async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Commits a change in the task's container, as its run's agent would, and returns the new tip.
function commitInContainer(factory: TestFactory, taskId: string, path = 'src/login.ts'): string {
  const workdir = factory.sandbox.workdirOf(taskId);
  factory.git.editFile(workdir, path, `${path} from the container`);
  factory.git.commitAll(workdir);
  return factory.git.branchTip(factory.sandbox.clonePathOf(taskId), factory.sandbox.prepared.at(-1)!.branch)!;
}

describe('an L2 AFK run', () => {
  test('executes in its task’s container, with the subscription token and the run’s git config at their paths there', async () => {
    const { factory, operator } = await attached();
    await operator.send(implementAtL2('#39'));

    const run = await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    const [spec] = factory.sandbox.prepared;
    expect(spec).toMatchObject({
      taskId: 'T1',
      clonePath: clone,
      branch: worktree!.branch,
      branches: [],
      sessionsDir: factory.executor.sessionsDir(worktree!.path),
    });
    expect(run).toMatchObject({
      autonomy: 'L2',
      cwd: worktree!.path,
      credential: 'subscription-token',
      token: 'oauth-token',
      container: { taskId: 'T1', workdir: factory.sandbox.workdirOf('T1') },
      guards: { start: worktree!.head, env: { GIT_CONFIG_GLOBAL: '/factory/run/gitconfig', GH_CONFIG_DIR: '/factory/run/gh', GIT_CONFIG_VALUE_0: '/factory/run/hooks' } },
    });
    expect(factory.sandbox.state('T1')).toBe('running');
    // The run's git config is written where the container mounts it, read-only.
    expect(readFileSync(join(spec!.runDir, 'gitconfig'), 'utf8')).toMatch(/pushInsteadOf =\s*$/m);
  });

  test('is told to keep what isn’t its work, files it asks the operator for included, in its container’s scratch folder, outside the clone the guards check', async () => {
    const { factory, operator } = await attached();
    await operator.send(implementAtL2('#39'));

    const run = await started(factory, 1);

    expect(run.container!.scratch).toBe('/scratch');
    expect(run.container!.scratch.startsWith(`${run.container!.workdir}/`)).toBe(false);
    // After the opening, so the skill it invokes stays first.
    expect(run.firstMessage).toMatch(/^\/factory:implement [^\n]*#39\n\n## Factory note\n\nLeave the worktree clean: /);
    expect(run.firstMessage).toContain('files you ask the operator for, in /scratch, outside the clone');
    expect(run.firstMessage).toContain('ask them to copy them there, never into the worktree.');
  });

  test('checked in the container, hands its commits to the host task branch, which its task moves on from', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);

    commitInContainer(factory, 'T1');
    const tip = commitInContainer(factory, 'T1', 'src/session.ts');
    factory.executor.report('R1', { type: 'runCompleted' });

    await tui.until((state) => state.tasks.T1?.stage === 'review');
    expect(factory.git.branchTip(clone, worktree!.branch)).toBe(tip);
    expect(factory.git.checked).toEqual([{ worktreePath: factory.sandbox.workdirOf('T1'), branches: [], committer: 'agents-factory[bot]@users.noreply.github.com' }]);
    expect(factory.sandbox.calls).toEqual(['prepare T1', 'bringOut T1', 'prepare T1']);
  });

  test('that broke a guard in its container fails, and its commits stay there', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);

    commitInContainer(factory, 'T1');
    factory.git.breakInvariant(factory.sandbox.workdirOf('T1'), 'The run added remotes: fork.');
    factory.executor.report('R1', { type: 'runCompleted' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.attentionQueue).toMatchObject([{ attention: 'failure', reason: 'The run broke the factory’s git guards. The run added remotes: fork.' }]);
    expect(factory.git.branchTip(clone, worktree!.branch)).toBe(worktree!.head);
  });

  test('whose commits can’t come out fails, saying why', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);

    factory.sandbox.fail('bringOut', 'factory/T1-39 has commits in the container and on the host that the other lacks.');
    factory.executor.report('R1', { type: 'runCompleted' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.attentionQueue).toMatchObject([
      {
        attention: 'failure',
        reason: 'The run completed, but the factory couldn’t bring its commits out of T1’s container: factory/T1-39 has commits in the container and on the host that the other lacks.',
      },
    ]);
  });

  test('without a subscription token fails, saying how to store one, and no container is made', async () => {
    const { factory, operator, tui } = await attached({ token: null });
    await operator.send(implementAtL2('#39'));

    const state = await tui.until((state) => state.attentionQueue.length === 1);
    expect(state.attentionQueue).toMatchObject([
      {
        attention: 'failure',
        reason: 'The factory has no subscription token for L2 runs yet: run `claude setup-token`, then `agents-factory setup token` to store what it prints.',
      },
    ]);
    expect(factory.sandbox.calls).toEqual([]);
    expect(factory.executor.started).toEqual([]);
  });

  test('whose container can’t be prepared fails, saying why', async () => {
    const { factory, operator, tui } = await attached();
    factory.sandbox.fail('prepare', 'Cannot connect to the Docker daemon.');
    await operator.send(implementAtL2('#39'));

    const state = await tui.until((state) => state.attentionQueue.length === 1);
    expect(state.attentionQueue).toMatchObject([{ attention: 'failure', reason: 'The factory couldn’t prepare T1’s container: Cannot connect to the Docker daemon.' }]);
    expect(factory.executor.started).toEqual([]);
  });
});

describe('an L2 run’s egress', () => {
  test('is allowed only to the built-in hosts, through its container’s proxy', async () => {
    const { factory, operator } = await attached();
    await operator.send(implementAtL2('#39'));

    await started(factory, 1);
    expect(factory.sandbox.prepared[0]!.egress).toEqual(BUILT_IN_EGRESS);
  });

  test('denied is logged on the run, and a failed run’s request lists the hosts it was denied', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);

    expect(factory.sandbox.request('T1', 'api.anthropic.com')).toBe(true);
    expect(factory.sandbox.request('T1', 'pypi.org')).toBe(false);
    factory.sandbox.request('T1', 'files.pythonhosted.org');
    factory.executor.report('R1', { type: 'runFailed', reason: 'pip install failed.' });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(state.runs.R1!.deniedHosts).toEqual(['pypi.org', 'files.pythonhosted.org']);
    expect(state.attentionQueue).toMatchObject([
      {
        attention: 'failure',
        reason: 'pip install failed. Its container’s egress proxy denied pypi.org and files.pythonhosted.org.',
        deniedHosts: ['pypi.org', 'files.pythonhosted.org'],
      },
    ]);
  });

  test('a denied host the operator allows for the task joins its egress, and the run is retried, for that task only', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    factory.sandbox.request('T1', 'pypi.org');
    factory.sandbox.request('T1', 'files.pythonhosted.org');
    factory.executor.report('R1', { type: 'runFailed', reason: 'pip install failed.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'answer', taskId: 'T1', allowHosts: ['pypi.org'] })).toEqual({ ok: true });

    const retried = await started(factory, 2);
    expect(retried).toMatchObject({ runId: 'R2', container: { taskId: 'T1' } });
    expect(factory.sandbox.prepared.at(-1)!.egress).toEqual([...BUILT_IN_EGRESS, 'pypi.org']);
    expect(factory.sandbox.request('T1', 'pypi.org')).toBe(true);
    const state = await tui.until((state) => state.tasks.T1?.egressHosts.length === 1);
    expect(state.tasks.T1!.egressHosts).toEqual(['pypi.org']);
    expect(state.attentionQueue.filter((item) => item.kind === 'attention')).toEqual([]);

    await operator.send(implementAtL2('#40'));
    await started(factory, 3);
    expect(factory.sandbox.prepared.at(-1)).toMatchObject({ taskId: 'T2', egress: BUILT_IN_EGRESS });
  });

  test('can be allowed only for hosts the failed run was denied', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The run hit its max turns (300) before it finished.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'answer', taskId: 'T1', allowHosts: ['pypi.org'] })).toEqual({
      ok: false,
      reason: 'T1’s run was denied no egress: there is no host to allow.',
    });

    await operator.send({ type: 'answer', taskId: 'T1' });
    await started(factory, 2);
    factory.sandbox.request('T1', 'pypi.org');
    factory.executor.report('R2', { type: 'runFailed', reason: 'pip install failed.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    expect(await operator.send({ type: 'answer', taskId: 'T1', allowHosts: ['evil.example'] })).toEqual({
      ok: false,
      reason: 'T1’s run wasn’t denied evil.example: allow only pypi.org.',
    });
    expect(await operator.send({ type: 'answer', taskId: 'T1', allowHosts: [] })).toMatchObject({ ok: false });
  });

  test('a child of an L2 task gets a frozen copy of its parent’s hosts', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    factory.sandbox.request('T1', 'pypi.org');
    factory.executor.report('R1', { type: 'runFailed', reason: 'pip install failed.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    await operator.send({ type: 'answer', taskId: 'T1', allowHosts: ['pypi.org'] });
    await started(factory, 2);

    await factory.executor.delegate('R2', { type: 'spawnChild', toolUseId: 'toolu_1', goal: 'Survey sign-out.', autonomy: 'L2', await: false });

    await started(factory, 3);
    expect(factory.sandbox.prepared.at(-1)).toMatchObject({ taskId: 'T2', egress: [...BUILT_IN_EGRESS, 'pypi.org'] });
  });

  test('denied to a run that completes is logged on the run, and asks nothing', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);

    factory.sandbox.request('T1', 'statsig.anthropic.com');
    factory.executor.report('R1', { type: 'runCompleted' });

    const state = await tui.until((state) => state.tasks.T1?.stage === 'review');
    expect(state.runs.R1!.deniedHosts).toEqual(['statsig.anthropic.com']);
    expect(state.attentionQueue.filter((item) => item.kind === 'attention')).toEqual([]);
  });
});

describe('handing off at L2', () => {
  test('resumes the HITL conversation in the task’s container, which shares the host’s sessions, from the handoff commit', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    const hitl = factory.executor.started[0]!;
    factory.executor.report('R1', { type: 'turnEnded' });
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    factory.executor.report('R1', { type: 'briefWritten', brief: { goal: 'Build the login flow.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
    factory.executor.report('R1', { type: 'turnEnded' });
    const { brief, tier, maxTurns } = (await tui.until((state) => !!state.tasks.T1?.handoff?.brief)).tasks.T1!.handoff!;

    expect(await operator.send({ type: 'handoff', taskId: 'T1', brief: brief!, continueAs: 'resume', autonomy: 'L2', tier, maxTurns })).toEqual({ ok: true });

    const afk = await started(factory, 2);
    const [worktree] = await factory.git.worktrees(clone);
    expect(afk).toMatchObject({ mode: 'AFK', autonomy: 'L2', sessionId: hitl.sessionId, resumesSession: true, container: { taskId: 'T1' }, guards: { start: worktree!.head } });
    expect(factory.sandbox.prepared[0]!.sessionsDir).toBe(factory.executor.sessionsDir(hitl.cwd!));
  });
});

describe('an L2 task’s children', () => {
  test('are cut from the parent’s tip in its container, run in containers of their own, and the parent’s next run gets an awaited child’s branch to merge', async () => {
    const { factory, tui } = await attached();
    await factory.attach().then((operator) => operator.send(implementAtL2('#39')));
    await started(factory, 1);
    const tip = commitInContainer(factory, 'T1');

    const reply = await factory.executor.delegate('R1', { type: 'spawnChild', toolUseId: 'toolu_1', goal: 'Survey sign-out.', autonomy: 'L2', await: true });

    expect(reply).toMatchObject({ ok: true });
    const state = await tui.until((state) => state.tasks.T2?.liveRunId === 'R2');
    const childBranch = state.tasks.T2!.branch!;
    expect(state.tasks.T2!.child).toMatchObject({ base: tip });
    expect(await started(factory, 2)).toMatchObject({ runId: 'R2', autonomy: 'L2', container: { taskId: 'T2' } });
    expect(factory.sandbox.prepared[1]).toMatchObject({ taskId: 'T2', branch: childBranch });

    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Waiting on children');
    commitInContainer(factory, 'T2', 'docs/signout.md');
    factory.executor.report('R2', { type: 'runCompleted' });

    await started(factory, 3);
    expect(factory.sandbox.prepared[2]).toMatchObject({ taskId: 'T1', branches: [childBranch] });
    expect(factory.git.branchTip(factory.sandbox.clonePathOf('T1'), childBranch)).toBe(factory.git.branchTip(clone, childBranch));
  });
});

describe('an L2 task’s container', () => {
  test('stops once its task has no live run, keeping the commits, and runs again for the next one', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The run hit its max turns (300) before it finished.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
    // A failed run may have left its turn running: a restart ends it first.
    expect(factory.sandbox.calls).toEqual(['prepare T1', 'bringOut T1', 'restart T1', 'bringOut T1', 'stop T1']);
  });

  test('goes at the task’s end, after a final bundle brings its last commits out to the branch the operator keeps', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The run hit its max turns (300) before it finished.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
    // Made after the run's commits came out, say by a turn cut short.
    const tip = commitInContainer(factory, 'T1');

    const asked = await operator.send({ type: 'cancel', taskId: 'T1' });
    expect(asked).toMatchObject({ ok: false, choose: [{ label: 'Keep branch' }, { label: 'Discard work' }] });
    expect(await operator.send({ type: 'cancel', taskId: 'T1', branch: 'keep' })).toEqual({ ok: true });

    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBeNull());
    // Cancel weighs the container's commits too, and the cleanup's final bundle comes before the removal.
    expect(factory.sandbox.calls.slice(5)).toEqual(['start T1', 'bringOut T1', 'stop T1', 'start T1', 'bringOut T1', 'remove T1']);
    expect(factory.git.branchTip(clone, worktree!.branch)).toBe(tip);
    expect(existsSync(factory.sandbox.prepared[0]!.runDir)).toBe(false);
  });

  test('that can’t be removed holds the cleanup back, saying why, and the worktree stays', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The run hit its max turns (300) before it finished.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    factory.sandbox.fail('start', 'Cannot connect to the Docker daemon.');
    await operator.send({ type: 'cancel', taskId: 'T1', branch: 'keep' });

    const state = await tui.until((state) => !!state.tasks.T1?.cleanup?.problem);
    expect(state.tasks.T1!.cleanup!.problem).toBe(
      'The factory couldn’t bring T1’s last commits out of its container and remove it, so it removed nothing yet: Cannot connect to the Docker daemon.',
    );
    expect(await factory.git.worktrees(clone)).toHaveLength(1);
    expect(factory.sandbox.state('T1')).toBe('stopped');
  });

  test('is restarted when the operator takes its run over, and its commits come out before the HITL run starts on the host', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    const tip = commitInContainer(factory, 'T1');

    await operator.send({ type: 'takeOver', taskId: 'T1' });

    const hitl = await started(factory, 2);
    expect(hitl).toMatchObject({ mode: 'HITL', container: null });
    expect(factory.sandbox.calls).toEqual(['prepare T1', 'restart T1', 'bringOut T1', 'stop T1']);
    expect(factory.git.branchTip(clone, worktree!.branch)).toBe(tip);
    expect(factory.sandbox.state('T1')).toBe('stopped');
    void tui;
  });

  test('is restarted after a graceful stop cut its run short, before the next daemon starts the requeued run in it', async () => {
    const { factory, operator } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);

    await factory.restart();

    const requeued = await started(factory, 2);
    expect(requeued).toMatchObject({ runId: 'R2', autonomy: 'L2', container: { taskId: 'T1' } });
    expect(factory.sandbox.calls).toEqual(['prepare T1', 'restart T1', 'bringOut T1', 'stop T1', 'prepare T1']);
  });

  test('still running a turn after a crash is restarted before the requeued run, and its commits come out', async () => {
    const { factory, operator } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    await factory.crash();
    // The crash left the container running the dead daemon's turn, which commits.
    await factory.sandbox.start('T1');
    const tip = commitInContainer(factory, 'T1');
    factory.sandbox.calls.length = 0;

    await factory.startDaemon();

    const requeued = await started(factory, 2);
    expect(requeued).toMatchObject({ autonomy: 'L2', guards: { start: tip } });
    expect(factory.sandbox.calls).toEqual(['restart T1', 'bringOut T1', 'prepare T1']);
    expect(factory.git.branchTip(clone, worktree!.branch)).toBe(tip);
  });
});

describe('without Docker', () => {
  test('L1 runs start as ever, with no scratch folder to be told of', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    factory.sandbox.failList('Cannot connect to the Docker daemon.');
    await factory.restart();
    await factory.registerRepo();
    const operator = await factory.attach();

    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: '#39' });

    const run = await started(factory, 1);
    expect(run).toMatchObject({ autonomy: 'L1', container: null, credential: 'subscription-host' });
    expect(run.firstMessage).not.toContain('scratch');
    expect(factory.sandbox.calls).toEqual([]);
  });
});

describe('setup token', () => {
  test('stores the subscription token in the credential store, which the next L2 run takes', async () => {
    const { factory, operator } = await attached({ token: null });

    expect(await operator.send({ type: 'setupToken', token: '  sk-ant-oat01-fresh \n' })).toEqual({ ok: true });
    expect(await operator.send({ type: 'setupToken', token: ' ' })).toEqual({ ok: false, reason: 'The token is empty: paste what `claude setup-token` printed.' });

    expect(await factory.secrets.read(SUBSCRIPTION_TOKEN_SECRET)).toBe('sk-ant-oat01-fresh');
    await operator.send(implementAtL2('#39'));
    expect(await started(factory, 1)).toMatchObject({ token: 'sk-ant-oat01-fresh' });
  });
});

describe('a turn that may still run in a container', () => {
  test('after an L2 run fails on its own, is ended with a restart before the container stops, and its commits come out', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);

    factory.executor.report('R1', { type: 'runFailed', reason: 'docker exec ended unexpectedly.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
    expect(factory.sandbox.calls).toEqual(['prepare T1', 'bringOut T1', 'restart T1', 'bringOut T1', 'stop T1']);
  });

  test('whose restart failed is ended before the next run is prepared there, and the run fails while it can’t be', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    factory.sandbox.fail('restart', 'Cannot connect to the Docker daemon.');
    factory.executor.report('R1', { type: 'runFailed', reason: 'docker exec ended unexpectedly.' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');

    await operator.send({ type: 'answer', taskId: 'T1' });

    const failed = await tui.until((state) => state.runs.R2?.status === 'ended');
    expect(failed.attentionQueue.at(-1)).toMatchObject({ attention: 'failure', reason: 'The factory couldn’t prepare T1’s container: Cannot connect to the Docker daemon.' });
    expect(factory.sandbox.calls.filter((call) => call === 'prepare T1')).toHaveLength(1);

    factory.sandbox.fail('restart', null);
    await operator.send({ type: 'answer', taskId: 'T1' });

    expect(await started(factory, 2)).toMatchObject({ runId: 'R3', container: { taskId: 'T1' } });
    const calls = factory.sandbox.calls;
    expect(calls.slice(calls.lastIndexOf('restart T1'))).toEqual(['restart T1', 'bringOut T1', 'prepare T1']);
  });

  test('after a crash, while Docker doesn’t answer the listing, is still restarted before the requeued run is prepared', async () => {
    const { factory, operator } = await attached();
    await operator.send(implementAtL2('#39'));
    await started(factory, 1);
    await factory.crash();
    // The crash left the container running the dead daemon's turn.
    await factory.sandbox.start('T1');
    factory.sandbox.calls.length = 0;
    factory.sandbox.failList('Cannot connect to the Docker daemon.');

    await factory.startDaemon();

    expect(await started(factory, 2)).toMatchObject({ runId: 'R2', container: { taskId: 'T1' } });
    expect(factory.sandbox.calls).toEqual(['restart T1', 'bringOut T1', 'prepare T1']);
  });
});
