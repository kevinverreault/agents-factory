// Seam 1 harness: a real daemon core over a real store on a temp file, with a
// scripted fake for every port but the routing table (a small file in the
// temp home that tests write as the operator would) and a controllable clock. Tests talk to it only
// through the client protocol, as a TUI would.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GITHUB_APP_SECRET, startDaemon, type Daemon, type DaemonOptions } from '../daemon/daemon.ts';
import { factoryPaths, type FactoryPaths } from '../daemon/paths.ts';
import { ArchiveError } from '../executor/executor.ts';
import { GitError } from '../git/git.ts';
import { GitHubError } from '../github/github.ts';
import { routingTable } from '../models/routing-table.ts';
import { connect, type FactoryConnection } from '../protocol/client.ts';
import { SandboxError } from '../sandbox/sandbox.ts';
import type { AwakeBlock, Processes } from '../os/processes.ts';
import { openStore, type Store } from '../store/store.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeExecutor } from './fake-executor.ts';
import { FakeDependencies } from './fake-dependencies.ts';
import { FakeGit } from './fake-git.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakeProcesses } from './fake-processes.ts';
import { FakeSandbox } from './fake-sandbox.ts';
import { FakeSecrets } from './fake-secrets.ts';
import { FakeSkillSets } from './fake-skill-sets.ts';

export type TestFactory = {
  paths: FactoryPaths;
  clock: FakeClock;
  executor: FakeExecutor;
  git: FakeGit;
  github: FakeGitHub;
  sandbox: FakeSandbox;
  secrets: FakeSecrets;
  processes: FakeProcesses;
  skillSets: FakeSkillSets;
  dependencies: FakeDependencies;
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
  // The daemon dies without a graceful stop: nothing it does from now on
  // reaches the store, which stays as the crash left it, with no
  // clean-shutdown marker, nor the OS, whose idle-sleep blocks it held
  // go with it.
  crash(): Promise<void>;
  // The running daemon crashes at its next call of `port.method`: once the
  // call is made (`after`, the default), or instead of making it
  // (`before`). From then on nothing it does lands, in the store or through
  // a port: each later call fails as its port fails, and its runs neither
  // start nor stop. Settles once it has crashed; `crash()` then stops it.
  crashAt(port: CrashPort, method: string, when?: 'before' | 'after'): Promise<void>;
  dispose(): Promise<void>;
};

// The ports a crash can be injected at.
export type CrashPort = 'git' | 'github' | 'sandbox';
const CRASHED = 'The daemon crashed.';
const failures: Record<CrashPort, new (message: string) => Error> = { git: GitError, github: GitHubError, sandbox: SandboxError };

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
  const sandbox = new FakeSandbox(git);
  const github = new FakeGitHub(clock, git);
  const secrets = new FakeSecrets();
  const processes = new FakeProcesses(clock);
  const dependencies = new FakeDependencies();
  if (!withoutApp) await secrets.write(GITHUB_APP_SECRET, JSON.stringify(await github.createApp(github.manifestCode())));
  const connections: FactoryConnection[] = [];
  const daemons: Daemon[] = [];
  // Cuts each daemon off from its store, as a crash would: nothing it writes after that lands.
  const crashes = new Map<Daemon, () => void>();
  // The crash point armed for the running daemon, if any.
  let armed: { port: CrashPort; method: string; when: 'before' | 'after'; crashed: () => void } | null = null;

  async function start(more: Partial<DaemonOptions> = {}): Promise<Daemon> {
    const opened = openStore(paths.storePath);
    let dead = false;
    // What the daemon does to the OS, until it crashes.
    const blocks = new Set<AwakeBlock>();
    const daemonProcesses: Processes = {
      adopt: async (runId, pid) => void (dead || (await processes.adopt(runId, pid))),
      sweep: async (runId, cli) => void (dead || (await processes.sweep(runId, cli))),
      async holdAwake() {
        const block = await processes.holdAwake();
        if (dead) block.release();
        else blocks.add(block);
        return block;
      },
    };
    const die = () => {
      dead = true;
      for (const block of blocks) block.release();
      armed?.crashed();
      armed = null;
    };
    // The port as this daemon reaches it: dead, every call fails as the port does.
    const reach = <T extends object>(port: CrashPort, target: T): T =>
      new Proxy(target, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (dead) return Promise.reject(new failures[port](CRASHED));
            const here = armed?.port === port && armed.method === key ? armed : null;
            if (here?.when === 'before') {
              die();
              return Promise.reject(new failures[port](CRASHED));
            }
            const result = value.apply(target, args);
            return here ? Promise.resolve(result).finally(die) : result;
          };
        },
      });
    // Dead, it starts and stops no run, and archives nothing.
    const reachExecutor = (target: FakeExecutor): FakeExecutor =>
      new Proxy(target, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (!dead || key === 'sessionsDir') return value.apply(target, args);
            if (key === 'history') return Promise.resolve([]);
            if (key === 'archive') return Promise.reject(new ArchiveError(CRASHED));
            return undefined;
          };
        },
      });
    const store: Store = {
      loadLifecycle: () => opened.loadLifecycle(),
      saveLifecycle: (lifecycle) => void (dead || opened.saveLifecycle(lifecycle)),
      takeCleanShutdown: () => opened.takeCleanShutdown(),
      markCleanShutdown: () => void (dead || opened.markCleanShutdown()),
      close: () => opened.close(),
    };
    try {
      const table = routingTable(paths.modelsTable);
      const daemon = await startDaemon({
        ...paths,
        store,
        clock,
        executor: reachExecutor(executor),
        git: reach('git', git),
        github: reach('github', github),
        sandbox: reach('sandbox', sandbox),
        secrets,
        skillSets,
        processes: daemonProcesses,
        dependencies,
        routingTable: table,
        ...overrides,
        ...more,
      });
      daemons.push(daemon);
      crashes.set(daemon, die);
      return daemon;
    } catch (error) {
      opened.close();
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
    sandbox,
    secrets,
    skillSets,
    processes,
    dependencies,
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
    crashAt(port, method, when = 'after') {
      return new Promise((crashed) => (armed = { port, method, when, crashed }));
    },
    async crash() {
      const daemon = daemons.at(-1)!;
      crashes.get(daemon)!();
      await daemon.stop();
    },
    async dispose() {
      for (const connection of connections) connection.close();
      for (const daemon of daemons) await daemon.stop();
      // Windows may hold a run's worktree a moment after its processes exit.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
