// The daemon core (ADR 0002): one per OS user, owning the store and every run.
// Clients reach it only through the protocol, and every command goes through
// the Lifecycle reducer.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Executor } from '../executor/executor.ts';
import type { Git } from '../git/git.ts';
import { initialLifecycle, reduce, type Lifecycle, type LifecycleAction, type Repository } from '../lifecycle/lifecycle.ts';
import { diffFactoryState, repositoryView, toFactoryState, type FactoryState } from '../protocol/factory-state.ts';
import {
  PROTOCOL_VERSION,
  readMessages,
  send,
  type ClientMessage,
  type CloneView,
  type Command,
  type DaemonStatus,
  type RepoCommand,
  type Reply,
} from '../protocol/protocol.ts';
import { DEFAULT_PRESET, readClone, whyMissing } from '../repositories/registry.ts';
import type { Store } from '../store/store.ts';
import type { Clock } from './clock.ts';

export type DaemonOptions = {
  pipePath: string;
  tokenPath: string;
  store: Store;
  clock: Clock;
  executor: Executor;
  git: Git;
  // How long the daemon waits with nothing needing a clock before it exits.
  idleExitMs?: number;
};

export const IDLE_EXIT_MS = 10 * 60_000;
// How often the daemon checks whether it is idle.
const TICK_MS = 5_000;

export interface Daemon {
  // Settles once the daemon has stopped, for whatever reason.
  readonly stopped: Promise<void>;
  stop(): Promise<void>;
}

export class DaemonAlreadyRunning extends Error {}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const token = randomBytes(32).toString('hex');
  const server = createServer();
  await listen(server, options.pipePath);
  // Written only once the pipe is ours, so a refused second daemon never
  // replaces the running daemon's token.
  mkdirSync(dirname(options.tokenPath), { recursive: true });
  writeFileSync(options.tokenPath, token, { mode: 0o600 });

  const { store, clock, executor, git } = options;
  let lifecycle: Lifecycle = store.loadLifecycle() ?? initialLifecycle();
  let published: FactoryState = toFactoryState(lifecycle);
  const startedAt = clock.now();
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
  let stopping: Promise<void> | null = null;

  // Idle exit (ADR 0002): the daemon stays up while anything needs a clock.
  let idleSince: number | null = null;
  const stopTicking = clock.every(TICK_MS, () => {
    if (needsAClock()) idleSince = null;
    else if ((idleSince ??= clock.now()) + (options.idleExitMs ?? IDLE_EXIT_MS) <= clock.now()) void stop();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      subscribers.delete(socket);
    });
    socket.on('error', () => {});
    let authenticated = false;
    send(socket, { type: 'hello', protocolVersion: PROTOCOL_VERSION });
    readMessages<ClientMessage>(socket, (message) => {
      if (!authenticated) {
        if (message.type === 'auth' && tokensMatch(message.token, token)) {
          authenticated = true;
          send(socket, { type: 'welcome' });
        } else {
          send(socket, { type: 'refused', reason: 'The token does not match.' });
          socket.end();
        }
        return;
      }
      switch (message.type) {
        case 'subscribe':
          subscribers.add(socket);
          send(socket, { type: 'snapshot', state: published });
          break;
        case 'command': {
          const { id, command } = message;
          void handle(command).then(
            (reply) => {
              send(socket, { type: 'reply', id, ...reply });
              if (command.type === 'daemon.stop') void stop();
            },
            (error: Error) => send(socket, { type: 'reply', id, ok: false, reason: error.message }),
          );
          break;
        }
      }
    });
  });

  async function handle(command: Command): Promise<Reply> {
    switch (command.type) {
      case 'daemon.status':
        // Queued, so the status reflects every change sent before it.
        return serially(async () => ({ ok: true, value: status() }));
      case 'daemon.stop':
        return { ok: true };
      case 'registerRepo':
        return registerRepo(command);
      case 'inspectClone': {
        const clone = await readClone(git, command.path);
        if ('refusal' in clone) return { ok: false, reason: clone.refusal };
        const value: CloneView = { repo: clone.repo, path: clone.path };
        return { ok: true, value };
      }
      default:
        return dispatch(command);
    }
  }

  // Registers the clone at `path` under its GitHub `owner/name` (ADR 0010).
  async function registerRepo({ path, baseBranch, defaultPreset }: Extract<RepoCommand, { type: 'registerRepo' }>): Promise<Reply> {
    const clone = await readClone(git, path);
    if ('refusal' in clone) return { ok: false, reason: clone.refusal };
    baseBranch ??= clone.defaultBranch ?? undefined;
    if (!baseBranch) {
      return {
        ok: false,
        reason:
          `The clone at ${clone.path} doesn't say which branch is origin's default. ` +
          'Name the base branch, or run `git remote set-head origin --auto` in the clone.',
      };
    }
    const reply = await dispatch({
      type: 'repoRegistered',
      repo: clone.repo,
      path: clone.path,
      baseBranch,
      defaultPreset: defaultPreset ?? DEFAULT_PRESET,
    });
    return reply.ok ? { ok: true, value: repositoryView(lifecycle.repositories[clone.repo]!) } : reply;
  }

  function status(): DaemonStatus {
    const runs = Object.values(lifecycle.runs);
    return {
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      startedAt,
      attachedTuis: subscribers.size,
      activeRuns: runs.filter((run) => run.status === 'active').length,
      suspendedRuns: runs.filter((run) => run.status === 'suspended').length,
      queuedTasks: Object.values(lifecycle.tasks).filter((task) => task.state === 'queued').length,
    };
  }

  // An active or suspended run, a queued task (a HITL one Ready for you
  // included, as ADR 0002 says) or an attached TUI.
  function needsAClock(): boolean {
    const { attachedTuis, activeRuns, suspendedRuns, queuedTasks } = status();
    return attachedTuis + activeRuns + suspendedRuns + queuedTasks > 0;
  }

  // The Lifecycle changes one action at a time: checking a clone before a run
  // starts waits on git, and nothing may change the Lifecycle meanwhile.
  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(job: () => Promise<T>): Promise<T> {
    const result = queue.then(job);
    queue = result.catch(() => {});
    return result;
  }

  // Every repository's clone is checked at start (ADR 0010).
  void serially(async () => {
    for (const [{ id, missing }, reason] of await checkClones(Object.values(lifecycle.repositories))) {
      if (reason) await settle({ type: 'repoMissing', repo: id, reason }, new Set());
      else if (missing) await settle({ type: 'repoFound', repo: id }, new Set([id]));
    }
  });

  // Runs an action through the Lifecycle, saves the result and tells every
  // subscriber what changed.
  function dispatch(action: LifecycleAction): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const refusal = await settle(action, new Set());
      if (refusal) return { ok: false, reason: refusal };
      if (action.type === 'createTask') return { ok: true, value: { taskId: `T${lifecycle.counters.task}` } };
      return { ok: true };
    });
  }

  // Applies the action once the clone of every run it starts is in place
  // (ADR 0010). A missing clone first marks its repository missing, which
  // raises one attention request for it, and the action is reduced again
  // without that repository's runs. `inPlace` holds the repositories whose
  // clones were already found in place, so they aren't checked twice.
  async function settle(action: LifecycleAction, inPlace: Set<string>): Promise<string | null> {
    for (;;) {
      const { state, refusal } = reduce(lifecycle, action, clock.now());
      if (refusal) return refusal;
      const missing = await missingClones(state, inPlace);
      if (missing.length === 0) {
        commit(state, action);
        return null;
      }
      for (const [repo, reason] of missing) await settle({ type: 'repoMissing', repo, reason }, inPlace);
    }
  }

  // Why each repository the new runs in `next` start in has lost its clone.
  // Each one found in place is added to `inPlace`.
  async function missingClones(next: Lifecycle, inPlace: Set<string>): Promise<[string, string][]> {
    const starting = Object.values(next.runs).filter((run) => !lifecycle.runs[run.id]);
    const repositories = [...new Set(starting.map((run) => next.tasks[run.taskId]!.repo))]
      .filter((repo) => !inPlace.has(repo))
      .flatMap((repo) => next.repositories[repo] ?? []);
    const missing: [string, string][] = [];
    for (const [{ id }, reason] of await checkClones(repositories)) {
      if (reason) missing.push([id, reason]);
      else inPlace.add(id);
    }
    return missing;
  }

  // Each repository with why its clone is gone, or null where it is in place.
  async function checkClones(repositories: Repository[]): Promise<[Repository, string | null][]> {
    const reasons = await Promise.all(repositories.map((repository) => whyMissing(git, repository)));
    return repositories.map((repository, i) => [repository, reasons[i] ?? null]);
  }

  function commit(state: Lifecycle, action: LifecycleAction): void {
    const before = lifecycle;
    lifecycle = state;
    store.saveLifecycle(lifecycle);
    publish();
    driveExecutor(before, action);
  }

  // Starts the runs the action started, and stops the live runs an operator
  // verb ended (a run event's own run has already ended on the executor).
  function driveExecutor(before: Lifecycle, action: LifecycleAction): void {
    for (const run of Object.values(lifecycle.runs)) {
      const was = before.runs[run.id];
      if (!was && run.status === 'active') {
        const task = lifecycle.tasks[run.taskId]!;
        executor.start(
          { runId: run.id, taskId: task.id, mode: run.mode, autonomy: run.autonomy, sessionId: task.sessionId!, resumesSession: run.resumesSession },
          (event) => void dispatch(event),
        );
      } else if (was && was.status !== 'ended' && run.status === 'ended' && !('runId' in action && action.runId === run.id)) {
        executor.stop(run.id);
      }
    }
  }

  function publish(): void {
    const next = toFactoryState(lifecycle);
    const ops = diffFactoryState(published, next);
    published = next;
    if (ops.length) for (const socket of subscribers) send(socket, { type: 'patch', ops });
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopTicking();
      // On Windows the pipe name stays taken until every connection is gone.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Destroyed only once flushed, so the reply to `daemon stop` still
      // reaches its client.
      for (const socket of sockets) socket.end(() => socket.destroy());
      await closed;
      // Whatever is changing the Lifecycle finishes before the store closes.
      await queue;
      store.close();
      resolveStopped();
    })();
    return stopping;
  }

  return { stopped, stop };
}

function tokensMatch(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function listen(server: Server, pipePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new DaemonAlreadyRunning(`A daemon is already listening on ${pipePath}.`) : error),
    );
    server.listen(pipePath, () => resolve());
  });
}
