// The daemon core (ADR 0002): one per OS user, owning the store and every run.
// Clients reach it only through the protocol, and every command goes through
// the Lifecycle reducer.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { capture } from '../artifacts/capture.ts';
import type { ConversationEvent, Executor, RunGuards, RunStart } from '../executor/executor.ts';
import { GitError, type Git, type RunSnapshot, type WorktreeState } from '../git/git.ts';
import {
  CLOSE_TICKET,
  GitHubError,
  installationSettings,
  READ_ONLY,
  type FactoryApp,
  type GitHub,
  type InstallationToken,
  type Permissions,
} from '../github/github.ts';
import { writeRunGh } from '../github/run-gh.ts';
import { FACTORY_IDENTITY, prepareRunGit } from '../guards/run-git.ts';
import {
  artifactsOf,
  betweenIterations,
  BRIEF_REQUEST,
  guard,
  initialLifecycle,
  isTerminal,
  liveRun,
  nextTaskId,
  openRequest,
  overdueRuns,
  reduce,
  ticketSources,
  unfinishedTasks,
  type AppCheck,
  type Lifecycle,
  type Readiness,
  type LifecycleAction,
  type LoopEvent,
  type Repository,
  type RepoEvent,
  type Run,
  type RunEvent,
  type Task,
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
  type GitHubCommand,
  type HandoffCommand,
  type HookEvent,
  type LaunchCommand,
  type PresetCommand,
  type PresetsView,
  type RepoCommand,
  type Reply,
  type SetupView,
} from '../protocol/protocol.ts';
import { RoutingTableError, type RoutingTableFile } from '../models/routing-table.ts';
import type { Routes } from '../models/routing.ts';
import { covers, FACTORY_ALLOW_LIST, readOperatorRules, type ToolCall } from '../permissions/permissions.ts';
import {
  appBlock,
  appStages,
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
import { SecretsError, type Secrets } from '../secrets/secrets.ts';
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
  // GitHub as the factory identity, and the credential store its App's key
  // lives in (ADR 0004). Only the daemon calls either.
  github: GitHub;
  secrets: Secrets;
  skillSets: SkillSets;
  // The routing table each run's tier resolves through when it starts (ADR 0009).
  routingTable: RoutingTableFile;
  worktreeRoot: string;
  // The user scope of workflow presets.
  presetsDir: string;
  // The operator's allow rules for L1 runs (ADR 0007).
  permissionsPath: string;
  // Where each AFK run's own git config and hooks go while it runs.
  runsRoot: string;
  // How long the daemon waits with nothing needing a clock before it exits.
  idleExitMs?: number;
};

export const IDLE_EXIT_MS = 10 * 60_000;
// The credential the factory identity's App lives under: its id, slug and private key.
export const GITHUB_APP_SECRET = 'github-app';
// How long before its expiry an AFK run's bot token is replaced, and how
// long after a failed replacement it is tried again.
const TOKEN_REFRESH_MS = 10 * 60_000;
const TOKEN_RETRY_MS = 60_000;
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

  const { store, clock, executor, git, github, secrets, skillSets, routingTable } = options;
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
  // Each suspended run's tool calls waiting on the gate until its request is answered.
  const held = new Map<string, ToolCall[]>();
  // Each guarded AFK run's worktree as it found it, checked once it ends (ADR 0007).
  const guarded = new Map<string, { worktree: string; snapshot: RunSnapshot }>();
  // Each guarded AFK run's read-only bot token (ADR 0004): its gh config
  // directory, and when it is next replaced.
  const botTokens = new Map<string, { repo: string; dir: string; refreshAt: number }>();
  // The tasks whose loop's step between iterations is under way on GitHub.
  const stepsInFlight = new Set<string>();
  // The factory identity's App, once read from the credential store: null
  // when there is none yet. `setup github` replaces it.
  let storedApp: Promise<FactoryApp | null> | null = null;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
  let stopping: Promise<void> | null = null;

  // Idle exit (ADR 0002): the daemon stays up while anything needs a clock.
  let idleSince: number | null = null;
  const stopTicking = clock.every(TICK_MS, () => {
    fireOverdueDeadlines();
    refreshBotTokens();
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
      case 'setupGitHub':
        return setUpGitHub(command);
      case 'checkApp':
        return serially(async (): Promise<Reply> => {
          if (!lifecycle.repositories[command.repo]) return { ok: false, reason: `${command.repo} is not registered.` };
          return { ok: true, value: await checkApp(command.repo) };
        });
      case 'launchTask':
        return launch(command);
      case 'advanceStage':
        // Named now, for a next stage whose context is fresh.
        return dispatch({ type: 'stageAdvanced', taskId: command.taskId, skip: command.skip ?? [], sessionId: randomUUID() });
      case 'openHandoff':
        return openHandoff(command.taskId);
      case 'handoff':
        return handOff(command);
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
    const action: RepoEvent = { type: 'repoRegistered', repo: clone.repo, path: clone.path, baseBranch, defaultPreset: defaultPreset ?? DEFAULT_PRESET };
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const refusal = await settle(action, new Set());
      if (refusal) return { ok: false, reason: refusal };
      await checkApp(clone.repo);
      return { ok: true, value: repositoryView(lifecycle.repositories[clone.repo]!) };
    });
  }

  // `setup github`: creates the factory identity's App from the manifest
  // flow's code and writes it, private key and all, straight into the
  // credential store (ADR 0004). Every repository is then checked again.
  function setUpGitHub({ code }: Extract<GitHubCommand, { type: 'setupGitHub' }>): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      let created: FactoryApp;
      try {
        created = await github.createApp(code);
        await secrets.write(GITHUB_APP_SECRET, JSON.stringify(created));
      } catch (error) {
        if (!(error instanceof GitHubError || error instanceof SecretsError)) throw error;
        return { ok: false, reason: `The factory’s GitHub App couldn’t be created: ${error.message}` };
      }
      storedApp = Promise.resolve(created);
      await checkEveryApp();
      const value: SetupView = { slug: created.slug, installationSettings: installationSettings(created.slug) };
      return { ok: true, value };
    });
  }

  // The factory identity's App, read once from the credential store.
  function factoryApp(): Promise<FactoryApp | null> {
    if (!storedApp) {
      const read = secrets.read(GITHUB_APP_SECRET).then((stored) => (stored === null ? null : (JSON.parse(stored) as FactoryApp)));
      // A store that couldn't be read is read again next time.
      read.catch(() => storedApp === read && (storedApp = null));
      storedApp = read;
    }
    return storedApp;
  }

  // Asks GitHub whether the App is installed on the repository, and caches
  // the answer on it. Called only from inside `serially`.
  async function checkApp(repo: string): Promise<AppCheck> {
    const checkedAt = clock.now();
    let check: AppCheck;
    try {
      const found = await factoryApp();
      if (!found) {
        check = { installed: false, checkedAt, reason: NO_APP, fixUrl: null };
      } else if (await github.isInstalled(found, repo)) {
        check = { installed: true, checkedAt };
      } else {
        const reason = `The factory’s GitHub App, ${found.slug}, isn’t installed on ${repo}.`;
        check = { installed: false, checkedAt, reason, fixUrl: installationSettings(found.slug) };
      }
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      const reason = `The factory couldn’t check whether its GitHub App is installed on ${repo}: ${error.message}`;
      check = { installed: false, checkedAt, reason, fixUrl: null };
    }
    // The repository may have been removed meanwhile.
    if (lifecycle.repositories[repo]) await settle({ type: 'appChecked', repo, check }, new Set());
    return check;
  }

  async function checkEveryApp(): Promise<void> {
    for (const repo of Object.keys(lifecycle.repositories)) await checkApp(repo);
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
      // No fallback to the operator's account (ADR 0004): a task whose
      // preset has AFK stages launches only where the App can work.
      const stages = appStages(resolved.preset);
      if (stages.length) {
        const check = await checkApp(repo);
        const blocked = appBlock(resolved.preset.name, stages, check);
        if (blocked) return { ok: false, reason: `${blocked}${!check.installed && check.fixUrl ? ` Install it from ${check.fixUrl}, then launch again.` : ''}` };
      }
      action.preset = { ...resolved.preset, repoCommit: presets.commit };
      action.stage = start.stage.id;
      action.opening = start.opening;
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

  // Opens the handoff sheet on how the task's worktree stands now.
  function openHandoff(taskId: string): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const action: LifecycleAction = { type: 'handoffOpened', taskId, readiness: { blockers: [], toCommit: [] } };
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, reason: refused };
      action.readiness = await readiness(lifecycle.tasks[taskId]!);
      const refusal = await settle(action, new Set());
      return refusal ? { ok: false, reason: refusal } : { ok: true };
    });
  }

  // The handoff sheet's confirm. Blocked unless the task's worktree is as
  // its AFK run's guards accept it (ADR 0007), checked afresh. The task's
  // uncommitted files are then committed to the task branch, as the HITL
  // work they are, and the task goes AFK.
  function handOff({ taskId, brief, continueAs, autonomy, tier, maxTurns }: Extract<HandoffCommand, { type: 'handoff' }>): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const action: LifecycleAction = { type: 'handedOff', taskId, brief, continueAs, autonomy, tier, maxTurns, committed: [], sessionId: randomUUID() };
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, reason: refused };
      const task = lifecycle.tasks[taskId]!;
      const ready = await readiness(task);
      if (ready.blockers.length) {
        // The sheet shows what blocks it.
        await settle({ type: 'handoffOpened', taskId, readiness: ready }, new Set());
        return { ok: false, reason: `The handoff is blocked. ${ready.blockers.join(' ')}` };
      }
      if (ready.toCommit.length) {
        try {
          await git.commit(task.worktree!.path, ready.toCommit, `Handoff of ${task.id}: ${task.title}`);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          return { ok: false, reason: `The handoff commit failed: ${error.message}` };
        }
      }
      action.committed = ready.toCommit;
      const refusal = await settle(action, new Set());
      return refusal ? { ok: false, reason: refusal } : { ok: true };
    });
  }

  // How the task's worktree stands for a handoff: the task branch checked
  // out, no change but to the task's own files, which the handoff commit
  // takes, and no `pushurl` the AFK run's push guard can't cover.
  async function readiness(task: Task): Promise<Readiness> {
    if (!task.worktree) return { blockers: [], toCommit: [] };
    const { path, branch } = task.worktree;
    let state: WorktreeState;
    try {
      state = await git.worktreeState(path);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return { blockers: [`The factory couldn't read ${task.id}’s worktree at ${path}: ${error.message}`], toCommit: [] };
    }
    const files = new Set(artifactsOf(lifecycle, task).flatMap((artifact) => (artifact.kind === 'file' ? [artifact.path] : [])));
    const toCommit = state.uncommitted.filter((file) => files.has(file));
    const others = state.uncommitted.filter((file) => !files.has(file));
    const blockers: string[] = [];
    if (state.branch !== branch) blockers.push(`${branch} isn’t checked out in ${task.id}’s worktree: ${state.branch ? `${state.branch} is` : 'HEAD is detached'}.`);
    if (others.length) {
      blockers.push(`The worktree has changes that are no artifact of ${task.id}, which the handoff commit won’t take: ${others.join(', ')}. Commit or discard them first.`);
    }
    if (state.pushUrls.length) {
      blockers.push(`A remote has a pushurl, which the AFK run’s push guard can’t cover: ${state.pushUrls.join(', ')}. Remove it first.`);
    }
    return { blockers, toCommit };
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
  // A loop between its iterations does too.
  function needsAClock(): boolean {
    const { attachedTuis, activeRuns, suspendedRuns, queuedTasks } = status();
    return attachedTuis + activeRuns + suspendedRuns + queuedTasks + stepsInFlight.size > 0;
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
    // So is whether the App is installed on each.
    await checkEveryApp();
    // A loop the daemon stopped between iterations carries on.
    driveLoops();
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
      const { state, refusal } = reduce(lifecycle, action, clock.now(), routes());
      if (refusal) return refusal;
      const missing = await missingClones(state, inPlace);
      if (missing.length === 0) {
        commit(state, action);
        return null;
      }
      for (const [repo, reason] of missing) await settle({ type: 'repoMissing', repo, reason }, inPlace);
    }
  }

  // The routing table, read afresh for each action, so `models update`
  // reaches the next run that starts.
  function routes(): Routes {
    try {
      return routingTable.current();
    } catch (error) {
      if (!(error instanceof RoutingTableError)) throw error;
      return { unreadable: `${error.message} Fix it, or run \`agents-factory models update\` to reset it to the routes this factory ships.` };
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
    driveLoops();
  }

  // Starts the step on GitHub of each loop between its iterations (ADR 0006):
  // picking the next ticket, or closing the one the last iteration did. Its
  // outcome goes through the Lifecycle like any other event.
  function driveLoops(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      if (stopping || stepsInFlight.has(task.id) || !betweenIterations(lifecycle, task)) continue;
      stepsInFlight.add(task.id);
      const step = task.loop!.step === 'pick' ? pickTicket(task) : closeTicket(task);
      void step.then(
        (event) =>
          // The step is over once its event is in: the next one may start from there.
          serially(async () => {
            stepsInFlight.delete(task.id);
            if (!stopping) await settle(event, new Set());
          }),
        (error) => {
          stepsInFlight.delete(task.id);
          throw error;
        },
      );
    }
  }

  // Reads the task's ticket set from GitHub with a read-only token, in
  // order: each source's sub-issues, or a ticket source itself when it has none.
  async function pickTicket(task: Task): Promise<LoopEvent> {
    try {
      const { token } = await appToken(task.repo, READ_ONLY);
      const { kind, refs: sources } = ticketSources(lifecycle, task)!;
      const refs: string[] = [];
      for (const source of sources) {
        // A spec is never a ticket itself.
        const subIssues = await github.subIssues(token, source);
        for (const ref of subIssues.length || kind === 'spec' ? subIssues : [source]) if (!refs.includes(ref)) refs.push(ref);
      }
      const tickets = [];
      for (const ref of refs) tickets.push(await github.readIssue(token, ref));
      const { head } = await git.snapshot(task.worktree!.path);
      return { type: 'ticketsRead', taskId: task.id, tickets, base: head, sessionId: randomUUID() };
    } catch (error) {
      if (!isGitHubFailure(error) && !(error instanceof GitError)) throw error;
      return { type: 'ticketsUnread', taskId: task.id, reason: error.message };
    }
  }

  // Closes the ticket the last iteration did as completed, as the App, with
  // a token minted for this write alone (ADR 0004), and a comment saying
  // where its work is.
  async function closeTicket(task: Task): Promise<LoopEvent> {
    const { ticket, commits } = task.loop! as { ticket: string; commits: string[] };
    try {
      const { token } = await appToken(task.repo, CLOSE_TICKET);
      await github.closeIssue(token, ticket, closingComment(task, commits));
      return { type: 'ticketClosed', taskId: task.id, ticket, commits };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return { type: 'ticketUnclosed', taskId: task.id, ticket, reason: error.message };
    }
  }

  // A token of the App's installation on the repository, with `permissions` alone.
  async function appToken(repo: string, permissions: Permissions): Promise<InstallationToken> {
    const found = await factoryApp();
    if (!found) throw new GitHubError(NO_APP);
    return github.mintToken(found, repo, permissions);
  }

  // Starts the runs the action started, and stops the live runs an operator
  // verb ended (a run event's own run has already ended on the executor).
  function driveExecutor(before: Lifecycle, action: LifecycleAction): void {
    for (const run of Object.values(lifecycle.runs)) {
      const was = before.runs[run.id];
      if (!was && run.status === 'active') {
        streamed.set(run.id, []);
        void startRun(run);
      } else if (was && was.status !== 'ended' && run.status === 'ended') {
        streamed.delete(run.id);
        held.delete(run.id);
        // A run ended by an operator verb or parked isn't checked: it never finished.
        unguard(run.id);
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
      // A suspended run's question gets its answers as the card's would, and
      // its tool call the operator's verdict.
      const request = openRequest(before, before.tasks[action.taskId]!)!;
      if (request.holdsRun && request.question) executor.answer(request.runId!, request.question.id, action.answers!);
      if (request.holdsRun && request.permission) {
        const answer = action.permission!;
        executor.permit(
          request.runId!,
          request.permission.id,
          'deny' in answer ? { allow: false, message: `The operator denied this: ${answer.deny.trim()}` } : { allow: true },
        );
      }
      // The run is back: the calls it held go to the gate in turn.
      const waiting = request.holdsRun ? (held.get(request.runId!) ?? []) : [];
      held.delete(request.runId!);
      for (const call of waiting) gate(request.runId!, call);
    } else if (action.type === 'permissionAsked') {
      // Unless it raised a request, the operator's earlier answers allowed the call.
      const { taskId } = lifecycle.runs[action.runId]!;
      if (openRequest(lifecycle, lifecycle.tasks[taskId]!)?.permission?.id !== action.call.id) executor.permit(action.runId, action.call.id, { allow: true });
    } else if (action.type === 'handoffOpened' && run) {
      // A run started for the brief opens on the request itself.
      const was = before.runs[run.id];
      if (was?.turn === 'operator' && run.turn === 'agent') executor.send(run.id, BRIEF_REQUEST);
      else if (was?.turn === 'agent' && !before.tasks[action.taskId]!.handoff) executor.interrupt(run.id);
    } else if (action.type === 'turnEnded') {
      const { queued } = before.runs[action.runId]!;
      const { taskId } = lifecycle.runs[action.runId]!;
      // The brief, asked for once the turn a handoff interrupted has ended.
      if (!before.tasks[taskId]!.handoff?.asked && lifecycle.tasks[taskId]!.handoff?.asked) executor.send(action.runId, BRIEF_REQUEST);
      else if (queued.length) executor.send(action.runId, queued.join('\n\n'));
    }
    // What the agent's turn or its tool calls changed in the worktree shows on an open handoff sheet.
    const task = action.type === 'turnEnded' ? lifecycle.tasks[lifecycle.runs[action.runId]!.taskId] : action.type === 'artifactsSeen' ? conversing : undefined;
    if (task?.handoff) void rereadReadiness(task.id);
  }

  function rereadReadiness(taskId: string): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      const task = lifecycle.tasks[taskId];
      if (stopping || !task?.handoff) return { ok: true };
      const refusal = await settle({ type: 'readinessRead', taskId, readiness: await readiness(task) }, new Set());
      return refusal ? { ok: false, reason: refusal } : { ok: true };
    });
  }

  // Starts the run on the executor. An AFK run in a worktree starts guarded
  // (ADR 0007), once its worktree is snapshotted, unless it ended meanwhile.
  async function startRun(run: Run): Promise<void> {
    const task = lifecycle.tasks[run.taskId]!;
    const cwd = task.worktree?.path ?? null;
    let guards: RunGuards | null = null;
    if (run.mode === 'AFK' && cwd) {
      let snapshot: RunSnapshot;
      try {
        snapshot = await git.snapshot(cwd);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        return void dispatch({ type: 'runFailed', runId: run.id, reason: `The factory couldn't read the run's worktree at ${cwd}: ${error.message}` });
      }
      // The run reads GitHub as the App, never as the operator (ADR 0004).
      let bot: BotToken;
      try {
        bot = await botToken(task.repo);
      } catch (error) {
        if (!isGitHubFailure(error)) throw error;
        return void dispatch({ type: 'runFailed', runId: run.id, reason: `The factory couldn’t give the run its read-only GitHub token: ${error.message}` });
      }
      if (lifecycle.runs[run.id]?.status !== 'active') return;
      const dir = join(options.runsRoot, run.id);
      const env = prepareRunGit(dir, FACTORY_IDENTITY, {
        task: task.id,
        run: run.id,
        model: run.model,
      });
      const ghConfigDir = join(dir, 'gh');
      Object.assign(env, writeRunGh(ghConfigDir, bot.user, bot.token));
      guarded.set(run.id, { worktree: cwd, snapshot });
      botTokens.set(run.id, { repo: task.repo, dir: ghConfigDir, refreshAt: bot.expiresAt - TOKEN_REFRESH_MS });
      guards = { start: snapshot.head, env };
    }
    const start: RunStart = {
      runId: run.id,
      taskId: task.id,
      mode: run.mode,
      autonomy: run.autonomy,
      sessionId: task.sessionId!,
      resumesSession: run.resumesSession,
      cwd,
      firstMessage: run.opening,
      model: run.model,
      maxTurns: run.maxTurns ?? null,
      // The scheduler's choice (ADR 0001): L2's profile comes with the sandbox.
      credential: 'subscription-host',
      plugin: run.skillSet ? skillSets.pathOf(run.skillSet) : null,
      guards,
    };
    executor.start(start, {
      // A session is named for each completed run now, in case the next
      // stage's context is fresh, as it is for `advanceStage`.
      report: (event) =>
        void checkedAfterRun(event).then((checked) => dispatch(checked.type === 'runCompleted' ? { ...checked, sessionId: randomUUID() } : checked)),
      converse: (event) => broadcast(run.id, event),
      askPermission: (call) => gate(run.id, call),
    });
  }

  // The run event, failed when it ends a guarded run that broke the git
  // invariants of its snapshot (ADR 0007), saying what broke.
  async function checkedAfterRun(event: RunEvent): Promise<RunEvent> {
    const guard = guarded.get(event.runId);
    if (!guard || (event.type !== 'runCompleted' && event.type !== 'runFailed')) return event;
    unguard(event.runId);
    // The factory's own branches for other tasks, cut while the run worked.
    const branches = Object.values(lifecycle.tasks).flatMap((task) =>
      task.worktree && task.worktree.path !== guard.worktree ? [task.worktree.branch] : [],
    );
    let broken: string[];
    try {
      broken = await git.violations(guard.worktree, guard.snapshot, branches);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      broken = [`The factory couldn't check the run's worktree: ${error.message}`];
    }
    if (broken.length === 0) return event.type === 'runCompleted' ? withCommits(event, guard.worktree) : event;
    const breach = `broke the factory’s git guards. ${broken.join(' ')}`;
    return event.type === 'runCompleted'
      ? { type: 'runFailed', runId: event.runId, reason: `The run ${breach}` }
      : { ...event, reason: `${event.reason} It also ${breach}` };
  }

  // A Ralph loop iteration's completion, with the commits on the task branch
  // since its iteration began, by which the Lifecycle judges it (ADR 0006).
  async function withCommits(event: Extract<RunEvent, { type: 'runCompleted' }>, worktree: string): Promise<RunEvent> {
    const run = lifecycle.runs[event.runId];
    const base = run?.ticket && lifecycle.tasks[run.taskId]!.loop?.base;
    if (!base) return event;
    try {
      return { ...event, commits: await git.commitsSince(worktree, base) };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return { type: 'runFailed', runId: event.runId, reason: `The factory couldn't read the iteration's commits: ${error.message}` };
    }
  }

  // A read-only token of the App's installation on the repository, and the
  // App's bot user it reads as.
  async function botToken(repo: string): Promise<BotToken> {
    const found = await factoryApp();
    if (!found) throw new GitHubError(NO_APP);
    return { user: `${found.slug}[bot]`, ...(await github.mintToken(found, repo, READ_ONLY)) };
  }

  // Replaces each guarded run's bot token that expires soon, in place: `gh`
  // reads it afresh at the run's next call. One that fails is tried again a
  // minute later, until the run ends.
  function refreshBotTokens(): void {
    for (const [runId, held] of botTokens) {
      if (held.refreshAt > clock.now()) continue;
      // None other starts while this one is under way.
      held.refreshAt = Infinity;
      void botToken(held.repo).then(
        (bot) => {
          if (botTokens.get(runId) !== held) return;
          writeRunGh(held.dir, bot.user, bot.token);
          held.refreshAt = bot.expiresAt - TOKEN_REFRESH_MS;
        },
        () => (held.refreshAt = clock.now() + TOKEN_RETRY_MS),
      );
    }
  }

  // Forgets the run's snapshot and bot token, and removes its git config,
  // hooks and gh config.
  function unguard(runId: string): void {
    botTokens.delete(runId);
    if (!guarded.delete(runId)) return;
    rmSync(join(options.runsRoot, runId), { recursive: true, force: true, maxRetries: 3 });
  }

  // The L1 gate (ADR 0007): a call the factory's allow list or the operator's
  // permissions file covers runs at once. The file is read for every call, so
  // a rule the operator adds holds from their next one. The Lifecycle decides
  // the rest: by the operator's earlier answers, or with a permission
  // request. A call asked about while another request holds its run is held
  // until that one is answered; one the Lifecycle won't ask about otherwise
  // is refused, with its reason.
  function gate(runId: string, call: ToolCall): void {
    const operatorRules = readOperatorRules(options.permissionsPath);
    if (covers([...FACTORY_ALLOW_LIST, ...operatorRules.rules], call)) return executor.permit(runId, call.id, { allow: true });
    void dispatch({ type: 'permissionAsked', runId, call, rulesProblem: operatorRules.error }).then((reply) => {
      if (reply.ok) return;
      if (lifecycle.runs[runId]?.status === 'suspended') held.set(runId, [...(held.get(runId) ?? []), call]);
      else executor.permit(runId, call.id, { allow: false, message: reply.reason });
    });
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

const NO_APP = 'The factory has no GitHub App yet: run `agents-factory setup github` to create it.';

// What closing a ticket says on it (ADR 0006): its work is on the task
// branch, not yet on the base branch, and at L1 only on the operator's machine.
function closingComment(task: Task, commits: string[]): string {
  const where = task.autonomy === 'L2' ? '' : ' Its commits are local to the operator’s machine until the task’s PR.';
  return (
    `Done on the task branch \`${task.worktree!.branch}\` by the agents factory’s task ${task.id} (${task.title}), ` +
    `in ${commits.map((commit) => commit.slice(0, 7)).join(', ')}.${where}`
  );
}

// An AFK run's read-only token, and the App's bot user it reads as.
type BotToken = { user: string; token: string; expiresAt: number };

// GitHub refused or was unreachable, the credential store couldn't be read,
// or what it holds isn't the App.
function isGitHubFailure(error: unknown): error is Error {
  return error instanceof GitHubError || error instanceof SecretsError || error instanceof SyntaxError;
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
