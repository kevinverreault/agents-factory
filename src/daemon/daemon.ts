// The daemon core (ADR 0002): one per OS user, owning the store and every run.
// Clients reach it only through the protocol, and every command goes through
// the Lifecycle reducer.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { capture } from '../artifacts/capture.ts';
import type { ConversationEvent, Executor } from '../executor/executor.ts';
import { GitError, type Git } from '../git/git.ts';
import {
  artifactsOf,
  guard,
  initialLifecycle,
  isTerminal,
  liveRun,
  nextTaskId,
  openRequest,
  overdueRuns,
  reduce,
  unfinishedTasks,
  type Lifecycle,
  type LifecycleAction,
  type Repository,
  type RepoEvent,
  type TaskLaunched,
} from '../lifecycle/lifecycle.ts';
import { diffFactoryState, repositoryView, toFactoryState, type FactoryState } from '../protocol/factory-state.ts';
import {
  PROTOCOL_VERSION,
  readMessages,
  send,
  type ClientMessage,
  type CloneView,
  type Command,
  type DaemonStatus,
  type HookEvent,
  type LaunchCommand,
  type PresetCommand,
  type PresetsView,
  type RepoCommand,
  type Reply,
} from '../protocol/protocol.ts';
import { DEFAULT_TIER } from '../models/routing.ts';
import {
  builtInPresets,
  issueRefs,
  launchDefault,
  planStart,
  presetChoices,
  presetFiles,
  REPO_PRESETS,
  resolvePreset,
  userPresets,
  type PresetFile,
} from '../presets/presets.ts';
import { DEFAULT_PRESET, readClone, whyMissing } from '../repositories/registry.ts';
import type { SkillSets } from '../skills/skill-set.ts';
import type { Store } from '../store/store.ts';
import { cutWorktree, fetchBase, taskWorktree, titleFrom } from '../worktree/task-worktree.ts';
import type { Clock } from './clock.ts';

export type DaemonOptions = {
  pipePath: string;
  tokenPath: string;
  store: Store;
  clock: Clock;
  executor: Executor;
  git: Git;
  skillSets: SkillSets;
  worktreeRoot: string;
  // The user scope of workflow presets.
  presetsDir: string;
  // How long the daemon waits with nothing needing a clock before it exits.
  idleExitMs?: number;
};

export const IDLE_EXIT_MS = 10 * 60_000;
// How often the daemon checks whether it is idle and fires overdue deadlines.
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

  const { store, clock, executor, git, skillSets } = options;
  let lifecycle: Lifecycle = store.loadLifecycle() ?? initialLifecycle();
  let published: FactoryState = toFactoryState(lifecycle);
  const startedAt = clock.now();
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  // Each run's conversation subscribers, each with its replay while the
  // history is being read (live events wait), or null once it is live.
  const conversations = new Map<string, Map<Socket, object | null>>();
  // What each live run streamed since this daemon started it: the CLI writes
  // the session file a moment after it streams.
  const streamed = new Map<string, ConversationEvent[]>();
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
  let stopping: Promise<void> | null = null;

  // Idle exit (ADR 0002): the daemon stays up while anything needs a clock.
  let idleSince: number | null = null;
  const stopTicking = clock.every(TICK_MS, () => {
    fireOverdueDeadlines();
    if (needsAClock()) idleSince = null;
    else if ((idleSince ??= clock.now()) + (options.idleExitMs ?? IDLE_EXIT_MS) <= clock.now()) void stop();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      subscribers.delete(socket);
      for (const watchers of conversations.values()) watchers.delete(socket);
      publish();
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
        case 'converse':
          void converse(socket, message.runId);
          break;
        case 'leaveConversation':
          conversations.get(message.runId)?.delete(socket);
          publish();
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
      case 'moveRepo':
        return moveRepo(command);
      case 'launchTask':
        return launch(command);
      case 'advanceStage':
        // Named now, for a next stage whose context is fresh.
        return dispatch({ type: 'stageAdvanced', taskId: command.taskId, skip: command.skip ?? [], sessionId: randomUUID() });
      case 'listPresets':
        return listPresets(command);
      case 'hookEvent':
        return captureArtifacts(command.event);
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

  // Re-points the repository whose clone now holds `path` there, after
  // repairing its unfinished tasks' worktrees: they still point at the clone's
  // old path (ADR 0010). Its `repo-missing` request closes and its runs can
  // start again.
  function moveRepo({ path }: Extract<RepoCommand, { type: 'moveRepo' }>): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const clone = await readClone(git, path);
      if ('refusal' in clone) return { ok: false, reason: clone.refusal };
      const action: RepoEvent = { type: 'repoMoved', repo: clone.repo, path: clone.path };
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, reason: refused };
      for (const task of unfinishedTasks(lifecycle, clone.repo)) {
        if (!task.worktree) continue;
        try {
          await git.repairWorktree(clone.path, task.worktree.path);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          return { ok: false, reason: `Couldn't repair the worktree of ${task.id} at ${task.worktree.path}: ${error.message}` };
        }
      }
      const refusal = await settle(action, new Set([clone.repo]));
      return refusal ? { ok: false, reason: refusal } : { ok: true, value: repositoryView(lifecycle.repositories[clone.repo]!) };
    });
  }

  // Freshly fetches the base branch, resolves the preset there and freezes it
  // with the pinned skill set (ADR 0005), cuts the task's worktree, and
  // starts the task at its start stage there (ADR 0010). The Lifecycle waits
  // meanwhile: the task id is in the branch name.
  function launch(command: LaunchCommand): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const { repo, prompt = '' } = command;
      const taskId = nextTaskId(lifecycle);
      const repository = lifecycle.repositories[repo];
      const action: TaskLaunched = {
        type: 'taskLaunched',
        repo,
        title: '',
        prompt,
        issues: command.issues ?? [],
        groups: command.groups ?? [],
        tier: command.tier ?? DEFAULT_TIER,
        operatorTier: command.tier ?? null,
        // Frozen once resolved, with the worktree and skill set.
        preset: null!,
        stage: '',
        opening: '',
        autonomy: command.autonomy ?? 'L1',
        maxTurns: command.maxTurns ?? null,
        priority: command.priority ?? 'normal',
        worktree: { branch: '', path: '' },
        sessionId: randomUUID(),
        skillSet: '',
      };
      // Refused before git is touched; an unregistered repository has no worktree.
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, reason: refused };
      const missing = await whyMissing(git, repository!);
      if (missing) {
        await settle({ type: 'repoMissing', repo, reason: missing }, new Set());
        return { ok: false, reason: guard(lifecycle, action)! };
      }
      const refs = issueRefs(action.issues, repo);
      if ('error' in refs) return { ok: false, reason: refs.error };
      action.issues = refs.issues;
      const unfetched = await fetchBase(git, repository!);
      if (unfetched) return { ok: false, reason: unfetched };
      const presets = await presetsOf(repository!);
      if ('error' in presets) return { ok: false, reason: presets.error };
      const resolved = resolvePreset(presets.files, command.preset ?? launchDefault(presets.files, repo, repository!.defaultPreset).name);
      if ('error' in resolved) return { ok: false, reason: resolved.error };
      const start = planStart(resolved.preset, command.stage, action);
      if ('error' in start) return { ok: false, reason: start.error };
      action.preset = { ...resolved.preset, repoCommit: presets.commit };
      action.stage = start.stage.id;
      action.opening = start.opening;
      action.tier = command.tier ?? start.stage.model ?? DEFAULT_TIER;
      action.title = titleFrom(prompt.trim() || action.issues.join(' ') || resolved.preset.name);
      action.worktree = taskWorktree(options.worktreeRoot, repository!, taskId, action.title);
      try {
        action.skillSet = (await skillSets.current()).version;
      } catch (error) {
        return { ok: false, reason: `The skill set couldn't be built: ${(error as Error).message}` };
      }
      const uncut = await cutWorktree(git, repository!, action.worktree);
      if (uncut) return { ok: false, reason: uncut };
      const refusal = await settle(action, new Set([repo]));
      if (refusal) return { ok: false, reason: refusal };
      await pruneSkillSets();
      return { ok: true, value: { taskId } };
    });
  }

  // Every preset a launch in the repository can pick from: the built-ins, the
  // operator's, and the repository's as `origin/<base_branch>` has them
  // (fetched or not), with that commit.
  async function presetsOf(repository: Repository): Promise<{ commit: string; files: PresetFile[] } | { error: string }> {
    const ref = `origin/${repository.baseBranch}`;
    try {
      const { commit, files } = await git.readDirectory(repository.path, ref, REPO_PRESETS);
      return { commit, files: [...builtInPresets(), ...userPresets(options.presetsDir), ...presetFiles('repo', files)] };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return { error: `Couldn't read the presets of ${repository.id} at ${ref}: ${error.message}` };
    }
  }

  // What a launch card offers in the repository, as its clone last fetched
  // it: a launch fetches first.
  async function listPresets({ repo }: PresetCommand): Promise<Reply> {
    const repository = lifecycle.repositories[repo];
    if (!repository) return { ok: false, reason: `${repo} is not registered.` };
    const presets = await presetsOf(repository);
    if ('error' in presets) return { ok: false, reason: presets.error };
    const { name, warning } = launchDefault(presets.files, repo, repository.defaultPreset);
    const value: PresetsView = { presets: presetChoices(presets.files), defaultPreset: name, warning };
    return { ok: true, value };
  }

  // Removes the skill set versions no unfinished task references (ADR 0005).
  async function pruneSkillSets(): Promise<void> {
    const tasks = Object.values(lifecycle.tasks).filter((task) => !isTerminal(task));
    await skillSets.prune(tasks.flatMap((task) => task.skillSet ?? []));
  }

  // Links what a tool call in a task's session produced to the task, and
  // rereads whether each of the task's files is committed: the agent may
  // have just committed them.
  function captureArtifacts(event: HookEvent): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      if (typeof event?.session_id !== 'string' || typeof event.cwd !== 'string') {
        return { ok: false, reason: 'A hook event needs a session id and a working directory.' };
      }
      const task = Object.values(lifecycle.tasks).find((task) => task.sessionId === event.session_id && !isTerminal(task));
      if (!task?.worktree) return { ok: false, reason: `No unfinished task has session ${event.session_id}.` };
      const captured = capture(event, { repo: task.repo, worktree: task.worktree.path });
      const issues = captured.flatMap((artifact) => (artifact.kind === 'issue' ? [artifact.url] : []));
      const paths = new Set(captured.flatMap((artifact) => (artifact.kind === 'file' ? [artifact.path] : [])));
      for (const artifact of artifactsOf(lifecycle, task)) if (artifact.kind === 'file') paths.add(artifact.path);
      if (paths.size === 0 && issues.length === 0) return { ok: true };
      const uncommitted = new Set(await git.uncommitted(task.worktree.path, [...paths]));
      const files = [...paths].map((path) => ({ path, committed: !uncommitted.has(path) }));
      const refusal = await settle({ type: 'artifactsSeen', taskId: task.id, files, issues }, new Set());
      return refusal ? { ok: false, reason: refusal } : { ok: true };
    });
  }

  // Replays the run's conversation from the Claude session file, then what
  // the run streamed that the file doesn't hold yet, then streams it live.
  async function converse(socket: Socket, runId: string): Promise<void> {
    const run = lifecycle.runs[runId];
    const task = run && lifecycle.tasks[run.taskId];
    if (!task) return;
    let watchers = conversations.get(runId);
    if (!watchers) conversations.set(runId, (watchers = new Map()));
    const replay = {};
    watchers.set(socket, replay);
    // The operator is in the conversation from now: it no longer waits for them.
    publish();
    // Taken now, so a run that ends during the read still has it.
    const live = streamed.get(runId) ?? [];
    const history =
      task.sessionId && task.worktree ? await executor.history({ sessionId: task.sessionId, cwd: task.worktree.path }) : [];
    // The client left, or asked again, while the file was read.
    if (watchers.get(socket) !== replay) return;
    const replayed = new Set(history.map((event) => event.id));
    for (const event of [...history, ...live.filter((event) => !replayed.has(event.id))]) {
      send(socket, { type: 'conversation', runId, event });
    }
    watchers.set(socket, null);
  }

  function broadcast(runId: string, event: ConversationEvent): void {
    streamed.get(runId)?.push(event);
    for (const [socket, replay] of conversations.get(runId) ?? []) {
      if (!replay) send(socket, { type: 'conversation', runId, event });
    }
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

  // Every repository's clone is checked at start (ADR 0010), and the skill
  // set versions finished tasks left behind are removed.
  void serially(async () => {
    await pruneSkillSets();
    for (const [{ id, missing }, reason] of await checkClones(Object.values(lifecycle.repositories))) {
      if (reason) await settle({ type: 'repoMissing', repo: id, reason }, new Set());
      else if (missing) await settle({ type: 'repoFound', repo: id }, new Set([id]));
    }
  });

  // Deadlines are wall-clock times persisted in the store (ADR 0003), never
  // in-memory timers, which a sleep may stretch. Overdue ones fire at start
  // and at every tick, so the first tick after a wake fires every deadline
  // that passed while the machine slept.
  function fireOverdueDeadlines(): void {
    if (overdueRuns(lifecycle, clock.now()).length) void dispatch({ type: 'deadlinesDue' });
  }
  fireOverdueDeadlines();

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
        streamed.set(run.id, []);
        executor.start(
          {
            runId: run.id,
            taskId: task.id,
            mode: run.mode,
            autonomy: run.autonomy,
            sessionId: task.sessionId!,
            resumesSession: run.resumesSession,
            cwd: task.worktree?.path ?? null,
            firstMessage: run.opening,
            model: run.model,
            maxTurns: run.maxTurns ?? null,
            // The scheduler's choice (ADR 0001): L2's profile comes with the sandbox.
            credential: 'subscription-host',
            plugin: run.skillSet ? skillSets.pathOf(run.skillSet) : null,
          },
          { report: (event) => void dispatch(event), converse: (event) => broadcast(run.id, event) },
        );
      } else if (was && was.status !== 'ended' && run.status === 'ended') {
        streamed.delete(run.id);
        if (!('runId' in action && action.runId === run.id)) executor.stop(run.id);
      }
    }
    // The conversation verbs act on the task's live run.
    const conversing = 'taskId' in action ? lifecycle.tasks[action.taskId] : undefined;
    const run = conversing && liveRun(lifecycle, conversing);
    // A message reaches the run on the operator's turn, or once the agent's
    // turn it was sent during ends, with whatever else waited.
    if (action.type === 'sendMessage') {
      if (before.runs[run!.id]!.turn === 'operator') executor.send(run!.id, action.text);
    } else if (action.type === 'interrupt') {
      executor.interrupt(run!.id);
    } else if (action.type === 'answerQuestion') {
      executor.answer(run!.id, action.questionId, action.answers);
    } else if (action.type === 'answer') {
      // A suspended run's question gets its answers as the card's would.
      const request = openRequest(before, before.tasks[action.taskId]!)!;
      if (request.holdsRun && request.question) executor.answer(request.runId!, request.question.id, action.answers!);
    } else if (action.type === 'turnEnded') {
      const { queued } = before.runs[action.runId]!;
      if (queued.length) executor.send(action.runId, queued.join('\n\n'));
    }
  }

  // The runs whose conversations some TUI has open.
  function watched(): Set<string> {
    return new Set([...conversations].filter(([, watchers]) => watchers.size > 0).map(([runId]) => runId));
  }

  function publish(): void {
    const next = toFactoryState(lifecycle, watched());
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
