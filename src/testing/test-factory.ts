// Seam 1 harness: a real daemon core over a real store on a temp file, with a
// scripted fake for every port and a controllable clock. Tests talk to it only
// through the client protocol, as a TUI would.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDaemon, type Daemon, type DaemonOptions } from '../daemon/daemon.ts';
import { factoryPaths, type FactoryPaths } from '../daemon/paths.ts';
import { connect, type FactoryConnection } from '../protocol/client.ts';
import { openStore } from '../store/store.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeExecutor } from './fake-executor.ts';
import { FakeGit } from './fake-git.ts';

export type TestFactory = {
  paths: FactoryPaths;
  clock: FakeClock;
  executor: FakeExecutor;
  git: FakeGit;
  // The daemon currently running, if any.
  daemon(): Daemon;
  // Connects a client holding the operator's token.
  attach(): Promise<FactoryConnection>;
  // Adds a clone of acme/widgets and registers it, as `repo add` would.
  registerRepo(): Promise<void>;
  // Starts another daemon instance over the same factory home and store.
  startDaemon(overrides?: Partial<DaemonOptions>): Promise<Daemon>;
  // Stops the daemon and starts a new one over the same store.
  restart(): Promise<void>;
  dispose(): Promise<void>;
};

export async function startTestFactory(overrides: Partial<DaemonOptions> = {}): Promise<TestFactory> {
  const home = mkdtempSync(join(tmpdir(), 'factory-seam1-'));
  const paths = factoryPaths({ AGENTS_FACTORY_HOME: home });
  const clock = new FakeClock();
  const executor = new FakeExecutor();
  const git = new FakeGit();
  const connections: FactoryConnection[] = [];
  const daemons: Daemon[] = [];

  async function start(more: Partial<DaemonOptions> = {}): Promise<Daemon> {
    const store = openStore(paths.storePath);
    try {
      const daemon = await startDaemon({ ...paths, store, clock, executor, git, ...overrides, ...more });
      daemons.push(daemon);
      return daemon;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  await start();

  return {
    paths,
    clock,
    executor,
    git,
    daemon: () => daemons.at(-1)!,
    async attach() {
      const connection = await connect(paths);
      connections.push(connection);
      return connection;
    },
    async registerRepo() {
      const path = resolve('/clones/widgets');
      git.addClone(path, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
      const connection = await connect(paths);
      const reply = await connection.send({ type: 'registerRepo', path });
      connection.close();
      if (!reply.ok) throw new Error(reply.reason);
    },
    startDaemon: start,
    async restart() {
      await daemons.at(-1)!.stop();
      await start();
    },
    async dispose() {
      for (const connection of connections) connection.close();
      for (const daemon of daemons) await daemon.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
