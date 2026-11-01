// Seam 1 harness: a real daemon core over a real store on a temp file, with a
// scripted fake for every port but the routing table (a small file in the
// temp home that tests write as the operator would) and a controllable clock. Tests talk to it only
// through the client protocol, as a TUI would.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GITHUB_APP_SECRET, startDaemon, type Daemon, type DaemonOptions } from '../daemon/daemon.ts';
import { factoryPaths, type FactoryPaths } from '../daemon/paths.ts';
import { routingTable } from '../models/routing-table.ts';
import { connect, type FactoryConnection } from '../protocol/client.ts';
import { openStore } from '../store/store.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeExecutor } from './fake-executor.ts';
import { FakeGit } from './fake-git.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakeSecrets } from './fake-secrets.ts';
import { FakeSkillSets } from './fake-skill-sets.ts';

export type TestFactory = {
  paths: FactoryPaths;
  clock: FakeClock;
  executor: FakeExecutor;
  git: FakeGit;
  github: FakeGitHub;
  secrets: FakeSecrets;
  skillSets: FakeSkillSets;
  // The daemon currently running, if any.
  daemon(): Daemon;
  // Connects a client holding the operator's token.
  attach(): Promise<FactoryConnection>;
  // Adds a clone of acme/widgets and registers it, as `repo add` would,
  // with the factory's App installed on it.
  registerRepo(): Promise<void>;
  // Starts another daemon instance over the same factory home and store.
  startDaemon(overrides?: Partial<DaemonOptions>): Promise<Daemon>;
  // Stops the daemon and starts a new one over the same store.
  restart(): Promise<void>;
  dispose(): Promise<void>;
};

// The factory's App is set up, as `setup github` leaves it, unless `withoutApp`.
export async function startTestFactory({
  withoutApp = false,
  ...overrides
}: Partial<DaemonOptions> & { withoutApp?: boolean } = {}): Promise<TestFactory> {
  const home = mkdtempSync(join(tmpdir(), 'factory-seam1-'));
  const paths = factoryPaths({ AGENTS_FACTORY_HOME: home });
  const clock = new FakeClock();
  const executor = new FakeExecutor();
  const git = new FakeGit();
  const skillSets = new FakeSkillSets();
  const github = new FakeGitHub(clock);
  const secrets = new FakeSecrets();
  if (!withoutApp) await secrets.write(GITHUB_APP_SECRET, JSON.stringify(await github.createApp(github.manifestCode())));
  const connections: FactoryConnection[] = [];
  const daemons: Daemon[] = [];

  async function start(more: Partial<DaemonOptions> = {}): Promise<Daemon> {
    const store = openStore(paths.storePath);
    try {
      const table = routingTable(paths.modelsTable);
      const daemon = await startDaemon({ ...paths, store, clock, executor, git, github, secrets, skillSets, routingTable: table, ...overrides, ...more });
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
    github,
    secrets,
    skillSets,
    daemon: () => daemons.at(-1)!,
    async attach() {
      const connection = await connect(paths);
      connections.push(connection);
      return connection;
    },
    async registerRepo() {
      const path = resolve('/clones/widgets');
      git.addClone(path, { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
      github.install('acme/widgets');
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
      // Windows may hold a run's worktree a moment after its processes exit.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
