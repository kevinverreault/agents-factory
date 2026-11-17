// Seam 1: Docker readiness and prepare failures (ADR 0015, "Bootstrap is
// budgeted" and "No Docker is an explicit choice"), through the client
// protocol. The daemon builds the image in the background when it starts,
// so a launch never waits for a build. A launch of a preset with contained
// stages checks Docker first. Where it isn't there, or a contained run's
// prepare fails, the operator is told why, and either retries or runs on
// the host this time. The factory never runs a contained stage on the host
// unless the operator chose to.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from './daemon.ts';

const factories: TestFactory[] = [];

// A preset whose grill is contained and whose notes stage is not.
const PLANNING = [
  'stages:',
  '  - { id: grill, kind: run, skill: grill-me, args: "{{prompt}}", mode: HITL, contained: true }',
  '  - { id: notes, kind: run, skill: notes, mode: HITL }',
  '  - { id: implement, kind: run, skill: implement, args: "{{prompt}}", mode: AFK }',
].join('\n');

const DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

async function attached({ before }: { before?: (factory: TestFactory) => void } = {}): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.secrets.write(SUBSCRIPTION_TOKEN_SECRET, 'oauth-token');
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'planning.preset.yaml'), PLANNING);
  await factory.registerRepo();
  if (before) {
    // As the daemon finds the machine when it starts.
    before(factory);
    await factory.restart();
  }
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

describe('the container image', () => {
  test('is built in the background when the daemon starts, and the state says when it is ready', async () => {
    const { factory, tui } = await attached({ before: (factory) => factory.sandbox.holdBuild() });

    expect((await tui.until((state) => state.sandbox.state === 'building')).sandbox).toEqual({ state: 'building', reason: null });
    factory.sandbox.finishBuild();

    expect((await tui.until((state) => state.sandbox.state === 'ready')).sandbox).toEqual({ state: 'ready', reason: null });
    expect(factory.sandbox.hasImage('agents-factory-sandbox:current')).toBe(true);
  });

  test('that failed to build says why, and is built again once asked to check', async () => {
    const { factory, operator, tui } = await attached({ before: (factory) => factory.sandbox.failBuild('failed to solve: no space left on device') });
    const failed = await tui.until((state) => state.sandbox.state === 'failed');
    expect(failed.sandbox).toEqual({ state: 'failed', reason: 'The factory couldn’t build its container image: failed to solve: no space left on device' });

    factory.sandbox.failBuild(null);
    factory.sandbox.holdBuild();
    expect(await operator.send({ type: 'checkSandbox' })).toEqual({ ok: true, value: { state: 'building', reason: null } });
    factory.sandbox.finishBuild();
    await tui.until((state) => state.sandbox.state === 'ready');
  });

  test('isn’t built while Docker is unavailable, and is once Docker is back and asked again', async () => {
    const { factory, operator, tui } = await attached({ before: (factory) => factory.sandbox.dockerDown(DOWN) });
    await tui.until((state) => state.sandbox.state === 'unavailable');
    const builds = factory.sandbox.builds;

    factory.sandbox.dockerDown(null);
    await operator.send({ type: 'checkSandbox' });

    await tui.until((state) => state.sandbox.state === 'ready');
    expect(factory.sandbox.builds).toBe(builds + 1);
  });
});

describe('a launch while Docker is unavailable', () => {
  test('the state says so, and a preset with a contained stage is refused, with Docker’s reason, a retry and running on the host this time', async () => {
    const { factory, operator, tui } = await attached({ before: (factory) => factory.sandbox.dockerDown(DOWN) });
    expect((await tui.until((state) => state.sandbox.state === 'unavailable')).sandbox).toEqual({ state: 'unavailable', reason: DOWN });

    const reply = await operator.send(launch);

    expect(reply).toEqual({
      ok: false,
      reason: `planning runs its grill stage contained, in the task’s container, but Docker isn’t available: ${DOWN}`,
      choose: [
        { label: 'Retry', command: launch },
        { label: 'Run on host this time', command: { ...launch, onHost: true } },
      ],
    });
    expect(tui.state().tasks).toEqual({});
    expect(factory.executor.started).toEqual([]);
    expect(factory.sandbox.prepared).toEqual([]);
  });

  test('retried once Docker is back, it launches contained', async () => {
    const { factory, operator, tui } = await attached({ before: (factory) => factory.sandbox.dockerDown(DOWN) });
    await tui.until((state) => state.sandbox.state === 'unavailable');
    factory.sandbox.dockerDown(null);

    expect(await operator.send(launch)).toMatchObject({ ok: true });

    expect(await started(factory, 1)).toMatchObject({ container: { taskId: 'T1' }, credential: 'subscription-token' });
    await tui.until((state) => state.sandbox.state === 'ready');
  });

  test('run on host this time runs its contained HITL runs on the host, where permission cards come back, until it is reopened', async () => {
    const { factory, operator, tui } = await attached({ before: (factory) => factory.sandbox.dockerDown(DOWN) });

    expect(await operator.send({ ...launch, onHost: true })).toMatchObject({ ok: true });

    expect(await started(factory, 1)).toMatchObject({ mode: 'HITL', container: null, credential: 'subscription-host', guards: null });
    const state = await tui.until((state) => state.runs.R1?.status === 'active');
    expect(state.runs.R1).toMatchObject({ stage: 'grill', contained: false, onHost: true, preparing: false });
    expect(state.tasks.T1).toMatchObject({ onHost: true });
    expect(factory.sandbox.prepared).toEqual([]);
    factory.executor.askPermission('R1', { id: 'toolu_1', tool: 'Bash', input: { command: 'npm publish' } });
    expect((await tui.until((state) => state.runs.R1?.permission !== null)).runs.R1?.permission).toMatchObject({ tool: 'Bash' });

    // Parked, then reopened with Docker back: it is contained again.
    factory.sandbox.dockerDown(null);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The CLI exited.' });
    await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });
    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });
    expect(await started(factory, 2)).toMatchObject({ container: { taskId: 'T1' } });
    expect((await tui.until((state) => state.runs.R2?.status === 'active')).tasks.T1).toMatchObject({ onHost: false });
  });

  test('a launch at a start stage past every contained stage launches as before', async () => {
    const { factory, operator } = await attached({ before: (factory) => factory.sandbox.dockerDown(DOWN) });

    expect(await operator.send({ ...launch, stage: 'implement' })).toMatchObject({ ok: true });

    expect(await started(factory, 1)).toMatchObject({ mode: 'AFK', autonomy: 'L1', container: null });
  });

  test('a preset with no contained stage launches as before', async () => {
    const { factory, operator } = await attached({ before: (factory) => factory.sandbox.dockerDown(DOWN) });

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' })).toMatchObject({ ok: true });

    expect(await started(factory, 1)).toMatchObject({ container: null });
  });
});

const UNPREPARED = 'docker: Error response from daemon: failed to create task for container: no space left on device.';

describe('a contained run whose container can’t be prepared', () => {
  test('fails before its CLI starts, saying why, and its failure offers to run on the host this time', async () => {
    const { factory, operator, tui } = await attached();
    factory.sandbox.fail('prepare', UNPREPARED);

    expect(await operator.send(launch)).toMatchObject({ ok: true });

    const state = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(state.runs.R1).toMatchObject({ outcome: 'failed', contained: true, preparing: false });
    expect(factory.executor.started).toEqual([]);
    expect(state.attentionQueue).toEqual([
      expect.objectContaining({ kind: 'attention', taskId: 'T1', attention: 'failure', reason: `The factory couldn’t prepare T1’s container: ${UNPREPARED}`, unprepared: true }),
    ]);
  });

  test('retried, starts again contained, on the message the failed run would have opened on', async () => {
    const { factory, operator, tui } = await attached();
    factory.sandbox.fail('prepare', UNPREPARED);
    await operator.send(launch);
    await tui.until((state) => state.runs.R1?.status === 'ended');
    factory.sandbox.fail('prepare', null);

    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: true });

    const run = await started(factory, 1);
    expect(run).toMatchObject({ runId: 'R2', container: { taskId: 'T1' }, resumesSession: false });
    expect(run.firstMessage).toMatch(/^\/factory:grill-me Grill me about the login flow\.\n\n## Factory note/);
    const state = await tui.until((state) => state.runs.R2?.status === 'active');
    expect(state.tasks.T1).toMatchObject({ label: 'In conversation', onHost: false });
    expect(state.attentionQueue).toEqual([]);
  });

  test('run on host this time starts it on the host, on that message, with permission cards back', async () => {
    const { factory, operator, tui } = await attached();
    factory.sandbox.fail('prepare', UNPREPARED);
    await operator.send(launch);
    await tui.until((state) => state.runs.R1?.status === 'ended');

    expect(await operator.send({ type: 'answer', taskId: 'T1', onHost: true })).toEqual({ ok: true });

    const run = await started(factory, 1);
    expect(run).toMatchObject({ runId: 'R2', container: null, credential: 'subscription-host', guards: null, resumesSession: false });
    expect(run.firstMessage).toMatch(/^\/factory:grill-me Grill me about the login flow\.$/);
    const state = await tui.until((state) => state.runs.R2?.status === 'active');
    expect(state.runs.R2).toMatchObject({ contained: false });
    expect(state.tasks.T1).toMatchObject({ onHost: true });
    factory.executor.askPermission('R2', { id: 'toolu_1', tool: 'Bash', input: { command: 'npm publish' } });
    expect((await tui.until((state) => state.runs.R2?.permission !== null)).runs.R2?.permission).toMatchObject({ tool: 'Bash' });
  });

  test('a failure of a run whose container was prepared, or of a run on the host, offers no run on host', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(launch);
    await started(factory, 1);
    factory.executor.report('R1', { type: 'runFailed', reason: 'The CLI exited.' });

    const state = await tui.until((state) => state.runs.R1?.status === 'ended');
    expect(state.attentionQueue).toEqual([expect.objectContaining({ attention: 'failure', unprepared: false })]);
    expect(await operator.send({ type: 'answer', taskId: 'T1', onHost: true })).toEqual({
      ok: false,
      reason: 'T1’s run didn’t fail preparing its container: retry it as it was.',
    });
  });
});

describe('the conversation of a contained run', () => {
  test('shows it preparing from launch, or reopen, until its CLI is up for the agent’s first turn', async () => {
    const { factory, operator, tui } = await attached({ before: (factory) => factory.sandbox.holdBuild() });
    await tui.until((state) => state.sandbox.state === 'building');

    // Launched while the image builds: its prepare waits for the build.
    expect(await operator.send(launch)).toMatchObject({ ok: true });
    expect((await tui.until((state) => state.runs.R1?.status === 'active')).runs.R1).toMatchObject({ contained: true, preparing: true });
    factory.sandbox.finishBuild();
    await started(factory, 1);
    expect(tui.state().runs.R1).toMatchObject({ preparing: true });

    factory.executor.report('R1', { type: 'runStarted', pid: 4242, createdAt: 1, model: 'claude-opus-5-5' });
    expect((await tui.until((state) => state.runs.R1?.cli !== null)).runs.R1).toMatchObject({ preparing: false });

    // Parked, and reopened.
    factory.executor.report('R1', { type: 'turnEnded' });
    await operator.send({ type: 'daemon.status' });
    factory.clock.advance(31 * 60_000);
    await tui.until((state) => state.tasks.T1?.label === 'Ready for you');
    expect(await operator.send({ type: 'open', taskId: 'T1' })).toEqual({ ok: true });
    expect((await tui.until((state) => state.runs.R2?.status === 'active')).runs.R2).toMatchObject({ preparing: true });
  });

  test('a run on the host never shows preparing', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', prompt: 'Grill me about the login flow.' });
    await started(factory, 1);

    expect((await tui.until((state) => state.runs.R1?.status === 'active')).runs.R1).toMatchObject({ contained: false, preparing: false });
  });
});
