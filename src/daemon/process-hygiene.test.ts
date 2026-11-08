// Seam 1: no run leaves processes behind, and unattended work isn't paused
// by idle sleep (ADR 0003). Every run's CLI tree is swept when the run
// ends, and at the next start after a crash; the machine is kept awake
// while an AFK run is active; and a run that fails shortly after a wake says so.
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

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

const afk = (title: string) => ({ type: 'createTask', repo: 'acme/widgets', title, mode: 'AFK', submit: true }) as const;

// The run's CLI comes up and starts an MCP server, and a shell that starts a tool.
function cliUp(factory: TestFactory, runId: string) {
  const cli = factory.processes.spawn();
  factory.executor.report(runId, { type: 'runStarted', ...cli, model: 'claude-sonnet-5-5' });
  const mcpServer = factory.processes.spawn(cli.pid);
  const shell = factory.processes.spawn(cli.pid);
  const tool = factory.processes.spawn(shell.pid);
  return { cli, descendants: [mcpServer.pid, shell.pid, tool.pid] };
}

describe('the descendant sweep', () => {
  test('once a run completes, nothing its CLI started is left running', async () => {
    const { factory, operator } = await attached();
    await operator.send(afk('Fix the login bug'));
    const { cli, descendants } = cliUp(factory, 'R1');
    // The CLI exits as the run completes.
    factory.processes.exit(cli.pid);

    factory.executor.report('R1', { type: 'runCompleted' });
    await settled(operator);

    expect(descendants.filter((pid) => factory.processes.isAlive(pid))).toEqual([]);
  });

  test('a run whose CLI failed before it came up still has its job closed', async () => {
    const { factory, operator } = await attached();
    await operator.send(afk('Fix the login bug'));
    // The executor adopted the CLI at spawn, and it started a tool, then died before its init.
    const cli = factory.processes.spawn();
    await factory.processes.adopt('R1', cli.pid);
    const tool = factory.processes.spawn(cli.pid);
    factory.processes.exit(cli.pid);

    factory.executor.report('R1', { type: 'runFailed', reason: 'Claude Code process exited with code 1.' });
    await settled(operator);

    expect(factory.processes.isAlive(tool.pid)).toBe(false);
  });

  test('a run ended by an operator verb is swept too, its CLI with it', async () => {
    const { factory, operator } = await attached();
    await operator.send(afk('Fix the login bug'));
    const { cli, descendants } = cliUp(factory, 'R1');
    await settled(operator);

    expect(await operator.send({ type: 'cancel', taskId: 'T1' })).toEqual({ ok: true });
    await settled(operator);

    expect([cli.pid, ...descendants].filter((pid) => factory.processes.isAlive(pid))).toEqual([]);
  });

  test('the next start after a crash sweeps the dead daemon’s runs, sparing a process that took a CLI’s PID since', async () => {
    const { factory, operator } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 2 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Fix the flaky test'));
    const one = cliUp(factory, 'R1');
    const two = cliUp(factory, 'R2');
    await settled(operator);

    await factory.crash();
    // R1's CLI died, and a process that came later took its PID and started
    // a child of its own. R2's CLI still runs.
    factory.processes.exit(one.cli.pid);
    factory.clock.advance(60_000);
    const stranger = factory.processes.spawn(1, one.cli.pid);
    const strangersChild = factory.processes.spawn(stranger.pid);
    await factory.startDaemon();
    const tui = watch(await factory.attach());
    await tui.until((state) => state.runs.R1?.outcome === 'interrupted' && state.runs.R2?.outcome === 'interrupted');

    const alive = (pids: number[]) => pids.filter((pid) => factory.processes.isAlive(pid));
    expect(alive([...one.descendants, two.cli.pid, ...two.descendants])).toEqual([]);
    expect(alive([stranger.pid, strangersChild.pid])).toEqual([stranger.pid, strangersChild.pid]);
  });
});

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

describe('a run that fails shortly after a wake', () => {
  const minutes = (n: number) => n * 60_000;
  const AFTER_WAKE = 'API Error: Connection reset. It failed shortly after the machine woke from sleep.';

  test('says so in its failure request', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');

    factory.clock.sleep(minutes(45));
    factory.clock.advance(minutes(4));
    factory.executor.report('R1', { type: 'runFailed', reason: 'API Error: Connection reset.' });

    const state = await tui.until((state) => state.attentionQueue.length > 0);
    expect(state.attentionQueue).toMatchObject([{ attention: 'failure', taskId: 'T1', reason: AFTER_WAKE }]);
  });

  test('says so when it fails on waking, before the daemon’s next tick', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');

    factory.clock.sleep(minutes(45));
    factory.executor.report('R1', { type: 'runFailed', reason: 'API Error: Connection reset.' });

    const state = await tui.until((state) => state.attentionQueue.length > 0);
    expect(state.attentionQueue).toMatchObject([{ attention: 'failure', reason: AFTER_WAKE }]);
  });

  test('a failure long after the wake, or with no sleep at all, carries no hint', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 2 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Fix the flaky test'));
    await tui.until((state) => state.runs.R2?.status === 'active');

    factory.clock.advance(minutes(30));
    factory.executor.report('R1', { type: 'runFailed', reason: 'API Error: Connection reset.' });
    factory.clock.sleep(minutes(45));
    factory.clock.advance(minutes(30));
    factory.executor.report('R2', { type: 'runFailed', reason: 'API Error: Connection reset.' });

    const state = await tui.until((state) => state.attentionQueue.length === 2);
    expect(state.attentionQueue).toMatchObject([{ reason: 'API Error: Connection reset.' }, { reason: 'API Error: Connection reset.' }]);
  });
});

describe('keep-awake', () => {
  test('the machine is kept from idle sleep exactly while an AFK run is active', async () => {
    const { factory, operator, tui } = await attached();
    const blocked = () => factory.processes.sleepBlocked();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Grill the billing plan', mode: 'HITL', submit: true });
    await operator.send({ type: 'open', taskId: 'T1' });
    await tui.until((state) => state.runs.R1?.status === 'active');
    expect(blocked()).toBe(false);

    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R2?.status === 'active');
    expect(blocked()).toBe(true);

    // A suspended run holds no block.
    factory.executor.report('R2', { type: 'attentionRaised', kind: 'question', question });
    await tui.until((state) => state.runs.R2?.status === 'suspended');
    expect(blocked()).toBe(false);

    await operator.send({ type: 'answer', taskId: 'T2', answers: { 'Which identity provider times out?': 'Okta' } });
    await tui.until((state) => state.runs.R2?.status === 'active');
    expect(blocked()).toBe(true);

    factory.executor.report('R2', { type: 'runCompleted' });
    await tui.until((state) => state.runs.R2?.status === 'ended');
    expect(blocked()).toBe(false);
  });

  test('the keep-awake setting turns it off, and back on, across restarts', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');
    expect(factory.processes.sleepBlocked()).toBe(true);

    expect(await operator.send({ type: 'setKeepAwake', on: false })).toEqual({ ok: true });
    await tui.until((state) => state.keepAwake === false);
    expect(factory.processes.sleepBlocked()).toBe(false);

    await factory.restart();
    const after = watch(await factory.attach());
    await after.until((state) => state.runs.R2?.status === 'active');
    expect(after.state().keepAwake).toBe(false);
    expect(factory.processes.sleepBlocked()).toBe(false);

    expect(await (await factory.attach()).send({ type: 'setKeepAwake', on: true })).toEqual({ ok: true });
    await after.until((state) => state.keepAwake === true);
    expect(factory.processes.sleepBlocked()).toBe(true);
  });

  test('a block that couldn’t be had is asked for again a minute later', async () => {
    const { factory, operator, tui } = await attached();
    factory.processes.failNextHold();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');
    expect(factory.processes.sleepBlocked()).toBe(false);

    factory.clock.advance(30_000);
    await settled(operator);
    expect(factory.processes.sleepBlocked()).toBe(false);

    factory.clock.advance(30_000);
    await settled(operator);
    expect(factory.processes.sleepBlocked()).toBe(true);
  });

  test('a graceful stop lets the machine sleep again, and so does a crash', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.runs.R1?.status === 'active');

    await factory.daemon().stop();
    expect(factory.processes.sleepBlocked()).toBe(false);

    await factory.startDaemon();
    await watch(await factory.attach()).until((state) => state.runs.R2?.status === 'active');
    expect(factory.processes.sleepBlocked()).toBe(true);
    await factory.crash();
    expect(factory.processes.sleepBlocked()).toBe(false);
  });
});
