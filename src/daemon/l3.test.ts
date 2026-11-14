// Seam 1: L3 (ADR 0014), through the client protocol. An L3 task runs as an
// L2 task does: in its own container, with the subscription token and the
// same git guards, and its open-pr stage, which requires L2, runs at L3. A
// stage ceiling of L2 clamps it. L3 needs the App's installation to grant
// Checks and Statuses read: without them the launch and the handoff refuse
// L3, with the reason and the link that approves them, and never fall back
// to L2. Under the operator policy, an L3 task ends In review as at L2.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import type { LaunchCommand } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const clone = resolve('/clones/widgets');
// The installation's own settings page, where the operator approves the App's new permissions.
const SETTINGS = 'https://github.com/settings/installations/1';
// What an installation made before the App asked for Checks and Statuses grants.
const BEFORE_L3 = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' } as const;
const REFUSED =
  'L3 merges a PR only once its checks pass, so the factory’s GitHub App needs Checks read and Statuses read on acme/widgets, ' +
  'which its installation doesn’t grant yet. Approve the App’s new permissions on GitHub, or pick L2. ' +
  `Approve them at ${SETTINGS}, then try again.`;

// A factory with a subscription token for contained runs, and a user preset
// `preset` when given.
async function attached({ preset }: { preset?: string } = {}): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'sk-ant-oat01-token');
  if (preset) {
    mkdirSync(factory.paths.presetsDir, { recursive: true });
    writeFileSync(join(factory.paths.presetsDir, 'unattended.preset.yaml'), preset);
  }
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

const implementAtL3: LaunchCommand = { type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: '#39', autonomy: 'L3' };

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

describe('an L3 task', () => {
  test('runs as an L2 task does: in its own container, with the subscription token and the git guards', async () => {
    const { factory, operator, tui } = await attached();

    expect(await operator.send(implementAtL3)).toEqual({ ok: true, value: { taskId: 'T1' } });

    const run = await started(factory, 1);
    const [worktree] = await factory.git.worktrees(clone);
    expect(run).toMatchObject({
      mode: 'AFK',
      autonomy: 'L3',
      cwd: worktree!.path,
      credential: 'subscription-token',
      token: 'sk-ant-oat01-token',
      container: { taskId: 'T1', workdir: factory.sandbox.workdirOf('T1') },
      guards: { start: worktree!.head, env: { GIT_CONFIG_GLOBAL: '/factory/run/gitconfig' } },
    });
    expect(factory.sandbox.state('T1')).toBe('running');
    expect(tui.state().tasks.T1).toMatchObject({ mode: 'AFK', autonomy: 'L3' });
  });

  test('runs its open-pr stage, which requires L2, and under the operator policy ends In review with its draft PR, as at L2', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(implementAtL3);

    await started(factory, 1);
    commitInContainer(factory, 'T1');
    factory.executor.report('R1', { type: 'runCompleted' });
    await started(factory, 2);
    factory.executor.report('R2', { type: 'runCompleted' });
    await started(factory, 3);
    factory.executor.report('R3', { type: 'prBodyWritten', body: 'Adds a login form.' });
    factory.executor.report('R3', { type: 'runCompleted' });

    const reviewing = await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(reviewing.tasks.T1).toMatchObject({ autonomy: 'L3', pr: { number: 101, draft: true }, publishing: null });
    expect(factory.github.pullRequests).toEqual([expect.objectContaining({ draft: true, base: 'main', state: 'open' })]);
    expect(reviewing.attentionQueue).toEqual([{ kind: 'review', taskId: 'T1' }]);
    expect(factory.executor.started.map(({ autonomy }) => autonomy)).toEqual(['L3', 'L3', 'L3']);
  });

  test('is clamped to L2 at a stage whose ceiling is L2, and runs at L3 again past it', async () => {
    const preset = 'stages:\n  - { id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", autonomy: L2 }\n  - { id: check, kind: run, mode: AFK, skill: code-review }\n';
    const { factory, operator, tui } = await attached({ preset });

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: 'Add a logout button.', autonomy: 'L3' })).toMatchObject({ ok: true });

    expect(await started(factory, 1)).toMatchObject({ autonomy: 'L2', container: { taskId: 'T1' } });
    factory.executor.report('R1', { type: 'runCompleted' });
    expect(await started(factory, 2)).toMatchObject({ autonomy: 'L3', container: { taskId: 'T1' } });
    expect(tui.state().tasks.T1?.autonomy).toBe('L3');
  });
});

describe('L3 where the App’s installation lacks Checks and Statuses read', () => {
  test('a launch at L3 is refused with the reason and the link that approves them, and no task is made at L2 instead', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.install('acme/widgets', BEFORE_L3);

    expect(await operator.send(implementAtL3)).toEqual({ ok: false, reason: REFUSED });

    expect(tui.state().tasks).toEqual({});
    expect(factory.executor.started).toEqual([]);
    expect(await factory.git.worktrees(clone)).toEqual([]);
    // L2 needs none of them.
    expect(await operator.send({ ...implementAtL3, autonomy: 'L2' })).toEqual({ ok: true, value: { taskId: 'T1' } });
  });

  test('the check records what the installation grants, and once the operator approves them the launch goes ahead', async () => {
    const { factory, operator, tui } = await attached();
    factory.github.install('acme/widgets', BEFORE_L3);

    expect(await operator.send({ type: 'checkApp', repo: 'acme/widgets' })).toMatchObject({ ok: true, value: { installed: true, permissions: BEFORE_L3, settingsUrl: SETTINGS } });
    await tui.until((state) => state.repositories['acme/widgets']?.app?.installed === true && !('checks' in state.repositories['acme/widgets'].app.permissions));

    factory.github.approvePermissions('acme/widgets');

    expect(await operator.send(implementAtL3)).toEqual({ ok: true, value: { taskId: 'T1' } });
    expect(tui.state().repositories['acme/widgets']!.app).toMatchObject({ installed: true, permissions: { checks: 'read', statuses: 'read' } });
  });

  test('a launch starting at a HITL stage takes no level, so it isn’t refused', async () => {
    const { factory, operator } = await attached();
    factory.github.install('acme/widgets', BEFORE_L3);

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' })).toEqual({ ok: true, value: { taskId: 'T1' } });
  });

  test('a handoff at L3 is refused with the reason and the link, the sheet stays open, and it goes ahead once they are approved', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    factory.executor.report('R1', { type: 'turnEnded' });
    await operator.send({ type: 'openHandoff', taskId: 'T1' });
    factory.executor.report('R1', { type: 'briefWritten', brief: { goal: 'Build the login flow.', decided: [], doneWhen: [], outOfScope: [], links: [] } });
    factory.executor.report('R1', { type: 'turnEnded' });
    const { brief, tier, maxTurns } = (await tui.until((state) => !!state.tasks.T1?.handoff?.brief)).tasks.T1!.handoff!;
    const confirm = { type: 'handoff', taskId: 'T1', brief: brief!, continueAs: 'resume', autonomy: 'L3', tier, maxTurns } as const;
    factory.github.install('acme/widgets', BEFORE_L3);

    expect(await operator.send(confirm)).toEqual({ ok: false, reason: REFUSED });
    expect(tui.state().tasks.T1).toMatchObject({ mode: 'HITL', handoff: expect.objectContaining({ brief }) });

    factory.github.approvePermissions('acme/widgets');
    expect(await operator.send(confirm)).toEqual({ ok: true });
    expect(await started(factory, 2)).toMatchObject({ mode: 'AFK', autonomy: 'L3', container: { taskId: 'T1' } });
  });

  test('a live task’s level can’t be raised to L3', async () => {
    const preset = 'stages:\n  - { id: draft, kind: run, mode: AFK, skill: to-spec, args: "{{prompt}}", exit: "artifact:spec" }\n';
    const { factory, operator, tui } = await attached({ preset });
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: 'Add a logout button.', autonomy: 'L2' });
    await started(factory, 1);
    factory.executor.report('R1', { type: 'runCompleted' });
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    factory.github.install('acme/widgets', BEFORE_L3);
    await operator.send({ type: 'checkApp', repo: 'acme/widgets' });

    expect(await operator.send({ type: 'setAutonomy', taskId: 'T1', autonomy: 'L3' })).toEqual({ ok: false, reason: REFUSED });
    expect(tui.state().tasks.T1?.autonomy).toBe('L2');
  });
});
