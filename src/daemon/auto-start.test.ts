// Seam 1: a TUI starting with no daemon running starts one, and closing the
// TUI never stops it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION, readMessages, send, type ClientMessage, type Command, type DaemonMessage } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch } from '../testing/watch.ts';
import { connectOrStart, restartDaemon, VersionSkew } from './auto-start.ts';
import { pipePathFor } from './paths.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

async function factoryWithNoDaemon(): Promise<TestFactory> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.daemon().stop();
  return factory;
}

describe('starting the TUI', () => {
  test('with no daemon running, the TUI starts one and attaches to it', async () => {
    const factory = await factoryWithNoDaemon();
    let starts = 0;

    const tui = await connectOrStart(factory.paths, () => {
      starts++;
      void factory.startDaemon();
    });

    expect(starts).toBe(1);
    expect(tui.protocolVersion).toBe(PROTOCOL_VERSION);
    tui.close();
  });

  test('closing the TUI leaves the daemon it started running', async () => {
    const factory = await factoryWithNoDaemon();
    const tui = await connectOrStart(factory.paths, () => void factory.startDaemon());
    await watch(tui).until(() => true);

    tui.close();

    const next = await connectOrStart(factory.paths, () => {
      throw new Error('The daemon should still be running.');
    });
    expect(await next.send({ type: 'daemon.status' })).toMatchObject({ ok: true });
    next.close();
  });

  test('a daemon that refuses the handshake is not started again', async () => {
    const factory = await startTestFactory();
    factories.push(factory);
    let starts = 0;

    await expect(
      connectOrStart({ pipePath: factory.paths.pipePath, tokenPath: `${factory.paths.home}/missing` }, () => starts++),
    ).rejects.toThrow();
    expect(starts).toBe(0);
  });

  test('a daemon on another protocol is refused, not started again, and told how to stop it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'af-old-daemon-'));
    const endpoint = { pipePath: pipePathFor(home), tokenPath: join(home, 'daemon.token') };
    await writeFile(endpoint.tokenPath, 'token');
    // A daemon from an older build: it welcomes any client, on protocol 3.
    const old = createServer((socket) => {
      send(socket, { type: 'hello', protocolVersion: 3 });
      readMessages(socket, () => send(socket, { type: 'welcome' }));
    });
    await new Promise<void>((resolve) => old.listen(endpoint.pipePath, resolve));
    let starts = 0;

    try {
      await expect(connectOrStart(endpoint, () => starts++)).rejects.toThrow(
        `The running daemon speaks protocol 3 and this agents-factory speaks ${PROTOCOL_VERSION}. ` +
          'Open agents-factory to restart it now or when idle, or stop it with `agents-factory daemon stop`, then try again.',
      );
      expect(starts).toBe(0);
    } finally {
      await new Promise((resolve) => old.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });

  test('a daemon that never comes up is reported after the timeout', async () => {
    const factory = await factoryWithNoDaemon();

    await expect(connectOrStart(factory.paths, () => {}, { timeoutMs: 300 })).rejects.toThrow(
      'The daemon did not start within 300 ms.',
    );
  });
});

// A daemon from an older build on the factory's pipe: it welcomes any
// client, records the commands it gets and replies to each as `reply` says.
// It stops on `daemon.stop`, or when the test stops it.
async function oldDaemon(pipePath: string, reply: (command: Command) => object = () => ({ ok: true })) {
  const commands: Command[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    send(socket, { type: 'hello', protocolVersion: 3 });
    readMessages<ClientMessage>(socket, (message) => {
      if (message.type === 'auth') return send(socket, { type: 'welcome' });
      if (message.type !== 'command') return;
      commands.push(message.command);
      send(socket, { type: 'reply', id: message.id, ...reply(message.command) } as DaemonMessage);
      if (message.command.type === 'daemon.stop') void stop();
    });
  });
  await new Promise<void>((resolve) => server.listen(pipePath, resolve));
  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.end(() => socket.destroy());
    }));
  return { commands, stop };
}

describe('a daemon of another version', () => {
  async function skewed(reply?: (command: Command) => object) {
    const factory = await factoryWithNoDaemon();
    const old = await oldDaemon(factory.paths.pipePath, reply);
    const skew = await connectOrStart(factory.paths, () => {
      throw new Error('A daemon is running.');
    }).catch((error: unknown) => error);
    expect(skew).toBeInstanceOf(VersionSkew);
    return { factory, old, skew: skew as VersionSkew };
  }

  test('restart now stops it gracefully, then the TUI starts its own build’s and attaches', async () => {
    const { factory, old, skew } = await skewed();
    expect(skew.daemonVersion).toBe(3);

    const tui = await restartDaemon(skew, 'now', factory.paths, () => void factory.startDaemon());

    expect(old.commands).toEqual([{ type: 'daemon.stop' }]);
    expect(tui.protocolVersion).toBe(PROTOCOL_VERSION);
    tui.close();
  });

  test('restart when idle waits for it to stop once no run is active, then attaches to a new one', async () => {
    const { factory, old, skew } = await skewed(() => ({ ok: true, value: { activeRuns: 2 } }));
    let waiting: number | null = null;
    let attached = false;

    const restarted = restartDaemon(skew, 'idle', factory.paths, () => void factory.startDaemon(), { onWaiting: (runs) => (waiting = runs) });
    void restarted.then(() => (attached = true));
    await vi.waitFor(() => expect(waiting).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(attached).toBe(false);
    await old.stop();

    const tui = await restarted;
    expect(old.commands).toEqual([{ type: 'daemon.restartWhenIdle' }]);
    expect(tui.protocolVersion).toBe(PROTOCOL_VERSION);
    tui.close();
  });

  test('one too old to restart when idle is left running, and the TUI says to restart it now instead', async () => {
    const { factory, old, skew } = await skewed();

    await expect(restartDaemon(skew, 'idle', factory.paths, () => void factory.startDaemon())).rejects.toThrow(
      'The running daemon is too old to restart when idle: restart it now, or stop it later with `agents-factory daemon stop`.',
    );
    await old.stop();
  });
});
