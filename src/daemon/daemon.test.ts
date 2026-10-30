// Seam 1: the daemon core through its client protocol.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { connect } from '../protocol/client.ts';
import type { DaemonStatus } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch } from '../testing/watch.ts';
import { DaemonAlreadyRunning } from './daemon.ts';

const factories: TestFactory[] = [];

async function factory(): Promise<TestFactory> {
  const started = await startTestFactory();
  factories.push(started);
  await started.registerRepo();
  return started;
}

afterEach(async () => {
  for (const started of factories.splice(0)) await started.dispose();
});

describe('connecting to the daemon', () => {
  test('a client holding the token completes the handshake and is told the protocol version', async () => {
    const { attach } = await factory();

    const tui = await attach();

    expect(tui.protocolVersion).toBe(5);
  });

  test('a client without the token is refused', async () => {
    const { paths } = await factory();
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'factory-other-')), 'token');
    writeFileSync(elsewhere, 'not-the-token');

    await expect(connect({ pipePath: paths.pipePath, tokenPath: elsewhere })).rejects.toThrow('The token does not match.');
  });

  test('a second daemon start is refused by the single-instance pipe name', async () => {
    const { startDaemon, attach } = await factory();

    await expect(startDaemon()).rejects.toBeInstanceOf(DaemonAlreadyRunning);
    // The running daemon keeps its token and its clients.
    expect((await attach()).protocolVersion).toBe(5);
  });
});

describe('the factory-state subscription', () => {
  test('two attached TUIs show the same snapshot and receive the same patches', async () => {
    const { attach } = await factory();
    const first = watch(await attach());
    const operator = await attach();
    const second = watch(operator);
    await first.until(() => true);
    await second.until(() => true);

    expect(await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Settle the glossary', mode: 'HITL', submit: true })).toEqual({
      ok: true,
      value: { taskId: 'T1' },
    });
    await first.until((state) => 'T1' in state.tasks);
    await second.until((state) => 'T1' in state.tasks);

    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.patches).toEqual(second.patches);
    expect(first.state().tasks.T1).toMatchObject({ title: 'Settle the glossary', label: 'Ready for you' });
    expect(first.state().attentionQueue).toEqual([{ kind: 'ready', taskId: 'T1' }]);
  });

  test('a TUI attaching later gets the current state as its snapshot', async () => {
    const { attach } = await factory();
    const operator = await attach();
    await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Run the spec', mode: 'AFK', submit: false });

    const late = watch(await attach());

    expect((await late.until(() => true)).tasks.T1).toMatchObject({ title: 'Run the spec', label: 'Draft' });
  });
});

describe('daemon status and stop', () => {
  test('daemon status reports the daemon, its attached TUIs and its runs', async () => {
    const { attach } = await factory();
    const tui = watch(await attach());
    await tui.until(() => true);
    const cli = await attach();
    await cli.send({ type: 'setSlotCap', cap: 1 });
    await cli.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the login bug', mode: 'AFK', submit: true });
    await cli.send({ type: 'createTask', repo: 'acme/widgets', title: 'Fix the flaky test', mode: 'AFK', submit: true });

    const reply = await cli.send({ type: 'daemon.status' });

    expect(reply).toEqual({
      ok: true,
      value: {
        pid: process.pid,
        protocolVersion: 5,
        startedAt: Date.UTC(2026, 9, 29, 9, 0, 0),
        attachedTuis: 1,
        activeRuns: 1,
        suspendedRuns: 0,
        queuedTasks: 1,
      },
    });
  });

  test('daemon stop stops the daemon and frees the pipe for the next one', async () => {
    const { attach, daemon, startDaemon, paths } = await factory();
    const cli = await attach();
    const closed = new Promise<void>((resolve) => cli.onClose(resolve));

    expect(await cli.send({ type: 'daemon.stop' })).toEqual({ ok: true });

    await daemon().stopped;
    await closed;
    await expect(connect(paths)).rejects.toThrow();
    await expect(startDaemon()).resolves.toBeDefined();
  });

  test('a new daemon over the same store shows the same tasks', async () => {
    const { attach, restart } = await factory();
    await (await attach()).send({ type: 'createTask', repo: 'acme/widgets', title: 'Settle the glossary', mode: 'HITL', submit: true });

    await restart();

    const operator = await attach();
    const tui = watch(operator);
    expect((await tui.until(() => true)).tasks.T1).toMatchObject({ title: 'Settle the glossary', label: 'Ready for you' });
    expect(await operator.send({ type: 'createTask', repo: 'acme/widgets', title: 'Write the spec', mode: 'HITL' })).toEqual({
      ok: true,
      value: { taskId: 'T2' },
    });
  });
});

describe('idle exit', () => {
  const minutes = (n: number) => n * 60_000;
  const isStopped = (daemon: { stopped: Promise<void> }) =>
    Promise.race([daemon.stopped.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);

  test('the daemon exits after about ten idle minutes with nothing needing a clock', async () => {
    const { clock, daemon } = await factory();

    clock.advance(minutes(9));
    expect(await isStopped(daemon())).toBe(false);

    clock.advance(minutes(1.5));
    expect(await isStopped(daemon())).toBe(true);
  });

  test('an attached TUI keeps the daemon up, and the idle minutes count from when it detaches', async () => {
    const { clock, daemon, attach } = await factory();
    const connection = await attach();
    await watch(connection).until(() => true);
    const cli = await attach();
    const attachedTuis = async () => ((await cli.send({ type: 'daemon.status' })) as { value: DaemonStatus }).value.attachedTuis;

    clock.advance(minutes(30));
    expect(await isStopped(daemon())).toBe(false);

    connection.close();
    while ((await attachedTuis()) > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    clock.advance(minutes(9));
    expect(await isStopped(daemon())).toBe(false);
    clock.advance(minutes(1.5));
    expect(await isStopped(daemon())).toBe(true);
  });

  test('a HITL task Ready for you counts as a queued task and keeps the daemon up', async () => {
    const { clock, daemon, attach } = await factory();
    await (await attach()).send({ type: 'createTask', repo: 'acme/widgets', title: 'Settle the glossary', mode: 'HITL', submit: true });

    clock.advance(minutes(30));

    expect(await isStopped(daemon())).toBe(false);
  });

  test('an active or suspended run keeps the daemon up; a task in review does not', async () => {
    const { clock, daemon, attach, executor } = await factory();
    const cli = await attach();
    await cli.send({ type: 'createTask', repo: 'acme/widgets', title: 'Implement the store', mode: 'AFK', submit: true });

    clock.advance(minutes(30));
    expect(await isStopped(daemon())).toBe(false);

    executor.report('R1', { type: 'attentionRaised', kind: 'question' });
    clock.advance(minutes(30));
    expect(await isStopped(daemon())).toBe(false);

    await cli.send({ type: 'answer', taskId: 'T1' });
    executor.report('R1', { type: 'runCompleted' });
    await cli.send({ type: 'daemon.status' });
    clock.advance(minutes(10.5));
    expect(await isStopped(daemon())).toBe(true);
  });
});
