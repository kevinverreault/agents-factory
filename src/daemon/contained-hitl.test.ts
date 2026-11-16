// Seam 1: contained HITL stages (ADR 0015), through the client protocol. A
// HITL stage its workflow preset marks contained runs in the task's
// container under `bypassPermissions`, on the subscription token, guarded
// as an L2 run is but committing as the operator. The operator converses
// with it as with a host HITL run, its questions still reach them as cards,
// and nothing else ever asks. It holds no slot, and its container runs only
// while it is live.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { FAKE_OPERATOR } from '../testing/fake-git.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];
const clone = resolve('/clones/widgets');

// A preset whose grill is contained and whose notes stage is not.
const PLANNING = [
  'stages:',
  '  - { id: grill, kind: run, skill: grill-me, args: "{{prompt}}", mode: HITL, contained: true }',
  '  - { id: notes, kind: run, skill: notes, mode: HITL }',
  '  - { id: implement, kind: run, skill: implement, args: "{{prompt}}", mode: AFK }',
].join('\n');

async function attached({ token = 'oauth-token' }: { token?: string | null } = {}): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  if (token) await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, token);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'planning.preset.yaml'), PLANNING);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const launch = { type: 'launchTask', repo: 'acme/widgets', preset: 'planning', prompt: 'Grill me about the login flow.' } as const;

async function started(factory: TestFactory, n: number) {
  await vi.waitFor(() => expect(factory.executor.started.length).toBeGreaterThanOrEqual(n));
  return factory.executor.started[n - 1]!;
}

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

const minutes = (n: number) => n * 60_000;

describe('a contained HITL stage', () => {
  test('runs in its task’s container, on the subscription token, guarded, under the operator’s own name, and its run says it is contained', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(launch);

    const run = await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    const [spec] = factory.sandbox.prepared;
    expect(spec).toMatchObject({ taskId: 'T1', clonePath: clone, branch: worktree!.branch, sessionsDir: factory.executor.sessionsDir(worktree!.path) });
    expect(factory.sandbox.state('T1')).toBe('running');
    expect(run).toMatchObject({
      mode: 'HITL',
      autonomy: null,
      cwd: worktree!.path,
      credential: 'subscription-token',
      token: 'oauth-token',
      container: { taskId: 'T1', workdir: factory.sandbox.workdirOf('T1') },
      guards: {
        start: worktree!.head,
        env: {
          GIT_CONFIG_GLOBAL: '/factory/run/gitconfig',
          GH_CONFIG_DIR: '/factory/run/gh',
          GIT_CONFIG_VALUE_0: '/factory/run/hooks',
          GIT_AUTHOR_NAME: FAKE_OPERATOR.name,
          GIT_AUTHOR_EMAIL: FAKE_OPERATOR.email,
          GIT_COMMITTER_NAME: FAKE_OPERATOR.name,
          GIT_COMMITTER_EMAIL: FAKE_OPERATOR.email,
        },
      },
    });
    // The per-run gitconfig of an AFK run, naming the operator: pushes fail, and commits carry the run's trailers.
    const gitconfig = readFileSync(join(spec!.runDir, 'gitconfig'), 'utf8');
    expect(gitconfig).toContain(`name = ${FAKE_OPERATOR.name}\n\temail = ${FAKE_OPERATOR.email}`);
    expect(gitconfig).toMatch(/pushInsteadOf =\s*$/m);
    expect(readFileSync(join(spec!.runDir, 'hooks', 'prepare-commit-msg'), 'utf8')).toContain('Factory-Run: R1');
    const state = await tui.until((state) => state.runs.R1?.status === 'active');
    expect(state.runs.R1).toMatchObject({ mode: 'HITL', contained: true, stage: 'grill' });
  });

  test('opens on its skill, then the L2 scratch-folder factory note', async () => {
    const { factory, operator } = await attached();
    await operator.send(launch);

    const run = await started(factory, 1);

    expect(run.firstMessage).toMatch(/^\/factory:grill-me Grill me about the login flow\.\n\n## Factory note\n\nLeave the worktree clean: /);
    expect(run.firstMessage).toContain('files you ask the operator for, in /scratch, outside the clone');
  });

  test('raises no permission card, even for a call no rule covers, while its questions still show as cards', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(launch);
    await started(factory, 1);

    factory.executor.askPermission('R1', { id: 'toolu_1', tool: 'Bash', input: { command: 'npm publish' } });
    await settled(operator);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true } });
    expect(tui.state().runs.R1?.permission).toBeNull();

    const question = {
      id: 'toolu_2',
      questions: [{ question: 'Which identity provider times out?', header: 'IdP', options: [{ label: 'Okta', description: '' }, { label: 'Entra', description: '' }], multiSelect: false }],
    };
    factory.executor.report('R1', { type: 'questionAsked', question });
    const asked = await tui.until((state) => state.runs.R1?.question !== null);
    expect(asked.runs.R1?.question).toEqual(question);
    expect(asked.attentionQueue.filter((item) => item.kind === 'attention')).toEqual([]);

    const answers = { 'Which identity provider times out?': 'Okta' };
    expect(await operator.send({ type: 'answerQuestion', taskId: 'T1', questionId: 'toolu_2', answers })).toEqual({ ok: true });
    expect(factory.executor.answered).toEqual([{ runId: 'R1', questionId: 'toolu_2', answers }]);
  });

  test('holds no slot: an AFK task starts beside it at a slot cap of 1', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(launch);
    await started(factory, 1);

    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK', submit: true });

    const state = await tui.until((state) => state.tasks.T2?.label === 'Running');
    expect(state.slots).toEqual({ active: 1, cap: 1 });
    expect(state.tasks.T1?.label).toBe('In conversation');
  });

  test('stops its container once parked, and reopening starts it again, with the host’s new commits, in the same session', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(launch);
    const first = await started(factory, 1);
    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);

    factory.clock.advance(minutes(31));
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');
    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
    // The turn's CLI dies with the container's restart; nothing comes out to the host.
    expect(factory.sandbox.calls).toEqual(['prepare T1', 'restart T1', 'stop T1']);

    // The operator commits on the host task branch meanwhile.
    const [worktree] = await factory.git.worktrees(clone);
    factory.git.editFile(worktree!.path, 'NOTES.md', 'from the host');
    factory.git.commitAll(worktree!.path);
    const hostTip = factory.git.branchTip(clone, worktree!.branch)!;

    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });

    const reopened = await started(factory, 2);
    expect(reopened).toMatchObject({ runId: 'R2', sessionId: first.sessionId, resumesSession: true, firstMessage: null, container: { taskId: 'T1' } });
    expect(factory.sandbox.state('T1')).toBe('running');
    expect(factory.sandbox.calls.at(-1)).toBe('prepare T1');
    expect(factory.git.branchTip(factory.sandbox.clonePathOf('T1'), worktree!.branch)).toBe(hostTip);
    expect(reopened.guards!.start).toBe(hostTip);
    expect((await tui.until((state) => state.runs.R2?.status === 'active')).runs.R2).toMatchObject({ contained: true });
  });

  test('cut short by a crash, its turn dies with a restart of its container, whose commits stay there, and the parked task reopens in it', async () => {
    const { factory, operator } = await attached();
    await operator.send(launch);
    await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    await factory.crash();
    // The crash left the container running the dead daemon's turn, which commits.
    await factory.sandbox.start('T1');
    factory.git.editFile(factory.sandbox.workdirOf('T1'), 'NOTES.md', 'from the grill');
    factory.git.commitAll(factory.sandbox.workdirOf('T1'));
    const tip = factory.git.branchTip(factory.sandbox.clonePathOf('T1'), worktree!.branch)!;
    factory.sandbox.calls.length = 0;

    await factory.startDaemon();
    const reattached = watch(await factory.attach());
    await reattached.until((state) => state.tasks.T1?.label === 'Ready for you');
    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
    expect(factory.sandbox.calls).toEqual(['restart T1', 'stop T1']);
    expect(factory.git.branchTip(clone, worktree!.branch)).toBe(worktree!.head);

    const reopener = await factory.attach();
    expect(await reopener.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });
    expect(await started(factory, 2)).toMatchObject({ runId: 'R2', resumesSession: true, container: { taskId: 'T1' }, guards: { start: tip } });
  });

  test('advancing to a stage that isn’t contained runs it on the host, and stops the container', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(launch);
    await started(factory, 1);
    factory.executor.report('R1', { type: 'turnEnded' });
    await settled(operator);

    expect(await operator.send({ type: 'advanceStage', taskId: 'T1' })).toEqual({ ok: true });

    const next = await started(factory, 2);
    expect(next).toMatchObject({ mode: 'HITL', container: null, credential: 'subscription-host', guards: null });
    expect((await tui.until((state) => state.runs.R2?.status === 'active')).runs.R2).toMatchObject({ stage: 'notes', contained: false });
    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
  });

  test('fails, saying why, when the operator has no git identity to commit under, or there is no subscription token', async () => {
    const { factory, operator, tui } = await attached();
    factory.git.operator = null;
    await operator.send(launch);

    const state = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(state.runs.R1).toMatchObject({ outcome: 'failed' });
    expect(factory.executor.started).toEqual([]);
    expect(JSON.stringify(state.attentionQueue)).toContain('git config --global user.email');

    const tokenless = await attached({ token: null });
    await tokenless.operator.send(launch);
    const failed = await tokenless.tui.until((state) => state.runs.R1?.status === 'ended');
    expect(JSON.stringify(failed.attentionQueue)).toContain('no subscription token');
  });
});

describe('a takeover', () => {
  test('continues on the host, even in a preset with contained stages', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ ...launch, stage: 'implement', autonomy: 'L2' });
    expect(await started(factory, 1)).toMatchObject({ mode: 'AFK', autonomy: 'L2', container: { taskId: 'T1' } });

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    expect(await started(factory, 2)).toMatchObject({ mode: 'HITL', container: null, credential: 'subscription-host', guards: null });
    expect((await tui.until((state) => state.runs.R2?.status === 'active')).runs.R2).toMatchObject({ contained: false });
    await vi.waitFor(() => expect(factory.sandbox.state('T1')).toBe('stopped'));
  });
});

describe('a task with no contained stage', () => {
  test('runs its HITL stages on the host, as before, and its runs say so', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });

    expect(await started(factory, 1)).toMatchObject({ mode: 'HITL', container: null, credential: 'subscription-host', guards: null });
    expect((await tui.until((state) => state.runs.R1?.status === 'active')).runs.R1).toMatchObject({ contained: false });
    expect(factory.sandbox.prepared).toEqual([]);
  });
});
