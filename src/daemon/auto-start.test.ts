// Seam 1: a TUI starting with no daemon running starts one, and closing the
// TUI never stops it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readMessages, send } from '../protocol/protocol.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch } from '../testing/watch.ts';
import { connectOrStart } from './auto-start.ts';
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
    expect(tui.protocolVersion).toBe(18);
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
        'The running daemon speaks protocol 3 and this agents-factory speaks 18. Stop it with `agents-factory daemon stop`, then try again.',
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
