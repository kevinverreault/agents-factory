// The daemon core (ADR 0002): one per OS user, owning the store and every run.
// Clients reach it only through the protocol, and every command goes through
// the Lifecycle reducer.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { capture } from '../artifacts/capture.ts';
import { ArchiveError, type ConversationEvent, type Delegation, type DelegationReply, type Executor, type RunGuards, type RunStart, type Verdict } from '../executor/executor.ts';
import { GitError, type Git, type RunSnapshot, type WorktreeState } from '../git/git.ts';
import {
  GitHubError,
  installationSettings,
  OPEN_PR,
  PR_WRITE,
  PUSH,
  READ_ONLY,
  TICKET_WRITE,
  type FactoryApp,
  type GitHub,
  type InstallationToken,
  type Issue,
  type Permissions,
} from '../github/github.ts';
import { writeRunGh } from '../github/run-gh.ts';
import { FACTORY_IDENTITY, prepareRunGit } from '../guards/run-git.ts';
import {
  allowedRules,
  allowsByRules,
  artifactsOf,
  betweenIterations,
  readingMap,
  BRIEF_REQUEST,
  childrenOf,
  coveredRequests,
  guard,
  initialLifecycle,
  isTerminal,
  keptChildBranches,
  label,
  liveRun,
  nextTaskId,
  openCard,
  openPermission,
  openRequest,
  overdueRuns,
  pullRequestOf,
  pushedBranch,
  reduce,
  rootOf,
  runReports,
  sessionsOf,
  subtree,
  childSpawnedBy,
  spawnsWithinDepth,
  ticketSources,
  unfinishedTasks,
  waitsOnPr,
  type AppCheck,
  type ChildSpawned,
  type CleanupEvent,
  type Lifecycle,
  type Readiness,
  type LifecycleAction,
  type LoopEvent,
  type PermissionAnswer,
  type PrReadEvent,
  type PublishEvent,
  type ResearchEvent,
  type ReopenEvent,
  type Repository,
  type RepoEvent,
  type Run,
  type RulesAnswer,
  type RunEvent,
  type SkillsSetup,
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
  type Option,
  type Reply,
  type RestartWhenIdle,
  type SetupView,
} from '../protocol/protocol.ts';
import { RoutingTableError, type RoutingTableFile } from '../models/routing-table.ts';
import type { Routes } from '../models/routing.ts';
import { addOperatorRules, readAllowRules, trackScripts, uncovered, type ToolCall } from '../permissions/permissions.ts';
import {
  appBlock,
  appStages,
  builtInPresets,
  issueRefs,
  launchDefault,
  planStart,
  presetChoices,
  presetFiles,
  CHILD_PRESET,
  REPO_PRESETS,
  resolvePreset,
  userPresets,
  type PresetFile,
} from '../presets/presets.ts';
import { DEFAULT_PRESET, readClone, whyMissing } from '../repositories/registry.ts';
import { SandboxError, egressFor, inRunDir, type Container, type Sandbox } from '../sandbox/sandbox.ts';
import { SecretsError, type Secrets } from '../secrets/secrets.ts';
import { checkSkillsSetup, unchecked } from '../skills/repo-setup.ts';
import type { SkillSets } from '../skills/skill-set.ts';
import type { Store } from '../store/store.ts';
import { childWorktree, cutWorktree, fetchBase, researchWorktree, taskWorktree, titleFrom } from '../worktree/task-worktree.ts';
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
  // Where L2 tasks' runs execute (ADR 0007): one container per task.
  sandbox: Sandbox;
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
  // Where each Done task's session transcripts are archived (ADR 0011).
  transcriptsRoot: string;
  // How long the daemon waits with nothing needing a clock before it exits.
  idleExitMs?: number;
};

export const IDLE_EXIT_MS = 10 * 60_000;
// The credential the factory identity's App lives under: its id, slug and private key.
export const GITHUB_APP_SECRET = 'github-app';
// The credential L2 runs authenticate with (ADR 0001): a subscription OAuth
// token, as `claude setup-token` prints it, the `subscription-token` profile.
export const SUBSCRIPTION_TOKEN_SECRET = 'subscription-token';
// How long before its expiry an AFK run's bot token is replaced, and how
// long after a failed replacement it is tried again.
const TOKEN_REFRESH_MS = 10 * 60_000;
const TOKEN_RETRY_MS = 60_000;
// How often the daemon checks whether it is idle and fires overdue deadlines.
const TICK_MS = 5_000;
// How often the daemon reads the PRs of the roots In review (ADR 0011), besides
// whenever a TUI attaches: the factory's only poll.
export const PR_POLL_MS = 15 * 60_000;

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

  const { store, clock, executor, git, github, sandbox, secrets, skillSets, routingTable } = options;
  let lifecycle: Lifecycle = store.loadLifecycle() ?? initialLifecycle();
  // Whether the daemon before this one stopped gracefully (ADR 0003).
  const cleanStart = store.takeCleanShutdown();
  let published: FactoryState = toFactoryState(lifecycle, new Set(), clock.now());
  const startedAt = clock.now();
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  // Each run's conversation subscribers, each with its replay while the
  // history is being read (live events wait), or null once it is live, and
  // whether it only follows the run's output.
  const conversations = new Map<string, Map<Socket, { replay: object | null; follows: boolean }>>();
  // What each live run streamed since this daemon started it: the CLI writes
  // the session file a moment after it streams.
  const streamed = new Map<string, ConversationEvent[]>();
  // Each suspended run's tool calls waiting on the gate until its request is answered.
  const held = new Map<string, ToolCall[]>();
  // Each guarded AFK run's worktree as it found it, checked once it ends
  // (ADR 0007), and the scripts the gate let it write to the temp folder.
  // An L2 run's are made in its container's clone, whose commits come out to
  // the host worktree once it ends.
  const guarded = new Map<string, Guarded>();
  // Each task's container this daemon knows of (ADR 0011), and whether it
  // runs: listed at start, then kept by what the daemon does to them.
  const containers = new Map<string, boolean>();
  // The tasks whose containers may still run a turn the daemon cut short:
  // restarted before anything else happens in them (ADR 0003).
  const staleTurns = new Set<string>();
  // The runs whose checks found broken guards, until their end is in.
  const brokenRuns = new Set<string>();
  // What the daemon does to each task's container, one step at a time, and
  // the tasks whose container is due to be settled.
  const containerJobs = new Map<string, Promise<unknown>>();
  const settling = new Set<string>();
  // Each guarded AFK run's read-only bot token (ADR 0004): its gh config
  // directory, and when it is next replaced.
  const botTokens = new Map<string, { repo: string; dir: string; refreshAt: number }>();
  // The tasks whose loop's step between iterations is under way on GitHub.
  const stepsInFlight = new Set<string>();
  // The Done roots whose cleanup this daemon has started, and those of them
  // still under way. One that failed is tried again by the next daemon.
  const cleanupsStarted = new Set<string>();
  const cleanupsInFlight = new Set<string>();
  // The cancelled tasks' tickets, as `<task> <ticket>`, whose reopening this
  // daemon has started, and those of them still under way. One that failed
  // is tried again once the operator answers, or by the next daemon.
  const reopensStarted = new Set<string>();
  const reopensInFlight = new Set<string>();
  // The roots' Push & open draft PR steps, as `<task> <step>`, this daemon
  // has started, and those of them still under way. One that failed is
  // tried again once the operator answers, or by the next daemon.
  const publishesStarted = new Set<string>();
  const publishesInFlight = new Set<string>();
  // The research children's steps on GitHub this daemon has started, and
  // those still under way, as `<task> <step>`. One that failed is tried
  // again once the operator answers, or by the next daemon.
  const researchStarted = new Set<string>();
  const researchInFlight = new Set<string>();
  // The HITL tasks whose held factory notes are being delivered.
  const notesInFlight = new Set<string>();
  // The tasks whose quick launch is opening its handoff sheet.
  const quickInFlight = new Set<string>();
  // The In review roots whose PR this daemon is reading on GitHub, and when
  // it next reads them all.
  const prReadsInFlight = new Set<string>();
  let nextPrPoll = clock.now() + PR_POLL_MS;
  // The factory identity's App, once read from the credential store: null
  // when there is none yet. `setup github` replaces it.
  let storedApp: Promise<FactoryApp | null> | null = null;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
  let stopping: Promise<void> | null = null;
  // Why the daemon starts no new run now, if it doesn't: it is stopping, or
  // stops once no run is active, to be restarted (ADR 0002).
  let holdRuns: string | null = null;
  let restartsWhenIdle = false;

  // Idle exit (ADR 0002): the daemon stays up while anything needs a clock.
  let idleSince: number | null = null;
  const stopTicking = clock.every(TICK_MS, () => {
    // What time alone changes: a usage snapshot going unknown.
    publish();
    fireOverdueDeadlines();
    refreshBotTokens();
    if (clock.now() >= nextPrPoll) pollPrs();
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
          pollPrs();
          break;
        case 'converse':
          void converse(socket, message.runId, message.follow ?? false);
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
              if (command.type === 'daemon.restartWhenIdle') restartIfIdle();
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
      case 'daemon.restartWhenIdle':
        return serially(async (): Promise<Reply> => {
          restartsWhenIdle = true;
          holdRuns ??= 'The daemon restarts once no run is active, so it starts no new run.';
          const value: RestartWhenIdle = { activeRuns: status().activeRuns };
          return { ok: true, value };
        });
      case 'registerRepo':
        return registerRepo(command);
      case 'moveRepo':
        return moveRepo(command);
      case 'setupGitHub':
        return setUpGitHub(command);
      case 'setupToken':
        return setUpToken(command.token);
      case 'checkApp':
        return serially(async (): Promise<Reply> => {
          if (!lifecycle.repositories[command.repo]) return { ok: false, reason: `${command.repo} is not registered.` };
          return { ok: true, value: await checkApp(command.repo) };
        });
      case 'checkSkills':
        return serially(async (): Promise<Reply> => {
          if (!lifecycle.repositories[command.repo]) return { ok: false, reason: `${command.repo} is not registered.` };
          return { ok: true, value: await checkSkills(command.repo, { fetch: true }) };
        });
      case 'launchTask':
        return launch(command);
      case 'advanceStage':
        // Named now, for a next stage whose context is fresh.
        return dispatch({
          type: 'stageAdvanced',
          taskId: command.taskId,
          skip: command.skip ?? [],
          sessionId: randomUUID(),
          ...(command.end && { end: true }),
        });
      case 'markDone':
        return markDone(command);
      case 'cancel':
        return cancel(command);
      case 'reopenPr':
        return reopenPr(command.taskId);
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
      await checkSkills(clone.repo);
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

  // `setup token`: the subscription token L2 runs take (ADR 0007) goes into
  // the credential store, and the next L2 run reads it from there.
  async function setUpToken(token: unknown): Promise<Reply> {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed) return { ok: false, reason: 'The token is empty: paste what `claude setup-token` printed.' };
    try {
      await secrets.write(SUBSCRIPTION_TOKEN_SECRET, trimmed);
    } catch (error) {
      if (!(error instanceof SecretsError)) throw error;
      return { ok: false, reason: `The token couldn’t be stored: ${error.message}` };
    }
    return { ok: true };
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

  async function checkEverySetup(): Promise<void> {
    for (const repo of Object.keys(lifecycle.repositories)) await checkSkills(repo);
  }

  // Reads whether the skill set's per-repo setup is on the repository's base
  // branch, as its clone last fetched it or, with `fetch`, freshly fetched,
  // and caches the answer on it. A missing clone keeps its last answer.
  // Called only from inside `serially`.
  async function checkSkills(repo: string, { fetch = false } = {}): Promise<SkillsSetup | null> {
    const repository = lifecycle.repositories[repo];
    if (!repository || repository.missing) return repository?.skills ?? null;
    let check: SkillsSetup;
    try {
      if (fetch) await git.fetch(repository.path, repository.baseBranch);
      check = await checkSkillsSetup(git, repository, clock.now());
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      check = unchecked(repository, clock.now(), `couldn’t fetch ${repository.baseBranch} from origin (${error.message})`);
    }
    // The repository may have been removed meanwhile.
    if (lifecycle.repositories[repo]) await settle({ type: 'skillsChecked', repo, check }, new Set());
    return check;
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
        quick: command.quick === true,
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
      // A missing setup is a warning on the repository, never a block (ADR 0010).
      await checkSkills(repo);
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

  // Mark done (ADR 0011): a root without a PR finishes once its task branch
  // is merged into the freshly fetched base branch on origin. Otherwise, or
  // when that can't be checked, the operator is asked to finish anyway.
  function markDone({ taskId, anyway = false }: Extract<LifecycleAction, { type: 'markDone' }>): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const action: LifecycleAction = { type: 'markDone', taskId, ...(anyway && { anyway }) };
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, reason: refused };
      const unmerged = anyway ? null : await whyUnmerged(lifecycle.tasks[taskId]!);
      if (unmerged) return { ok: false, reason: `${unmerged} Finish anyway?`, confirm: { type: 'markDone', taskId, anyway: true } };
      const refusal = await settle(action, new Set());
      if (refusal) return { ok: false, reason: refusal };
      // A setup task's work, say, may just have landed on the base branch.
      // Unless finished anyway, `whyUnmerged` has just fetched it.
      await checkSkills(lifecycle.tasks[taskId]!.repo, { fetch: anyway });
      return { ok: true };
    });
  }

  // Cancel (ADR 0011): the task and its subtree end at once. Unless the
  // operator already chose, a root task branch holding commits on no branch
  // of origin first has the operator choose Keep branch (the default) or
  // Discard work; with none, the branch goes without asking.
  function cancel({ taskId, branch }: Extract<LifecycleAction, { type: 'cancel' }>): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const action: LifecycleAction = { type: 'cancel', taskId, ...(branch && { branch }) };
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, reason: refused };
      if (!branch) {
        const unique = (await bringOutForCancel(lifecycle.tasks[taskId]!)) ?? (await workAtStake(lifecycle.tasks[taskId]!));
        if (unique) {
          const choose: Option[] = [
            { label: 'Keep branch', command: { type: 'cancel', taskId, branch: 'keep' } },
            { label: 'Discard work', command: { type: 'cancel', taskId, branch: 'discard' } },
          ];
          return { ok: false, reason: unique, choose };
        }
        action.branch = 'discard';
      }
      const refusal = await settle(action, new Set());
      return refusal ? { ok: false, reason: refusal } : { ok: true };
    });
  }

  // Reopen PR (ADR 0011): the daemon reopens the root's PR, closed unmerged,
  // as the App, then the request that asked is answered. A refusal from
  // GitHub leaves it open, saying why.
  function reopenPr(taskId: string): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const action: LifecycleAction = { type: 'reopenPr', taskId };
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, reason: refused };
      const task = lifecycle.tasks[taskId]!;
      const problem = await asApp(`reopen PR #${task.pr!.number}`, async () => {
        const { token } = await appToken(task.repo, PR_WRITE);
        await github.reopenPr(token, prRef(task.repo, task.pr!.number));
      });
      if (problem) return { ok: false, reason: problem };
      const refusal = await settle(action, new Set());
      return refusal ? { ok: false, reason: refusal } : { ok: true };
    });
  }

  // Makes a write on GitHub as the App (ADR 0004): null once it is made, or
  // why GitHub refused it, as the operator reads it.
  async function asApp(what: string, write: () => Promise<void>): Promise<string | null> {
    try {
      await write();
      return null;
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return `The factory couldn’t ${what} on GitHub as its App: ${error.message}`;
    }
  }

  // Reads the PR of each root In review on GitHub (ADR 0011), one at a time
  // per root: what it found goes through the Lifecycle like any other event.
  // It is only a read: one that fails, however it fails, is made again at
  // the next poll, and never stops the daemon.
  function pollPrs(): void {
    nextPrPoll = clock.now() + PR_POLL_MS;
    for (const task of Object.values(lifecycle.tasks)) {
      if (stopping || !waitsOnPr(task) || prReadsInFlight.has(task.id)) continue;
      prReadsInFlight.add(task.id);
      void readPr(task)
        .then((event) =>
          serially(async () => {
            prReadsInFlight.delete(task.id);
            // A root that moved on meanwhile refuses what was read: the next poll reads it again.
            if (stopping || !event || (await settle(event, new Set()))) return;
            // A setup task's work, say, has just landed on the base branch.
            if (event.state === 'merged') await checkSkills(task.repo, { fetch: true });
          }),
        )
        .catch(() => {})
        .finally(() => prReadsInFlight.delete(task.id));
    }
  }

  // Where the root's PR stands, read as the App with a read-only token, or
  // null when GitHub couldn't say: the next poll asks again.
  async function readPr(task: Task): Promise<PrReadEvent | null> {
    try {
      const { token } = await appToken(task.repo, READ_ONLY);
      return { type: 'prRead', taskId: task.id, state: await github.readPr(token, prRef(task.repo, task.pr!.number)) };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return null;
    }
  }

  // What deleting the root task's branch would lose, or null when nothing
  // would: commits on no branch of origin, as the clone last saw it, besides
  // the task branch the factory pushed, which the cancel deletes too. When
  // that can't be read, the branch is treated as holding work.
  async function workAtStake(task: Task): Promise<string | null> {
    const repository = lifecycle.repositories[task.repo];
    if (!task.worktree || task.parent || !repository) return null;
    const { branch } = task.worktree;
    const pushed = pushedBranch(task);
    try {
      const commits = await git.unpushed(repository.path, branch, pushed ? { besides: pushed } : {});
      if (commits.length === 0) return null;
      const count = commits.length === 1 ? '1 commit that exists' : `${commits.length} commits that exist`;
      return `${branch} has ${count} nowhere else${pushed ? ' once its branch on GitHub is deleted' : ''}.`;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return `Couldn’t check whether ${branch} holds work that exists nowhere else: ${error.message}`;
    }
  }

  // Brings what a root's container holds out to its task branch, so the
  // cancel sheet weighs it too: null once done, or when it has none, else
  // why it couldn't, which is work at stake. The container is settled after.
  async function bringOutForCancel(task: Task): Promise<string | null> {
    if (task.parent || !task.worktree || !containers.has(task.id)) return null;
    const { path, branch } = task.worktree;
    try {
      await onContainer(task.id, async () => {
        await sandbox.start(task.id);
        containers.set(task.id, true);
        await sandbox.bringOut(task.id, path, branch);
      });
      return null;
    } catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      return `Couldn’t bring ${task.id}’s commits out of its container, where they may be the only copy: ${error.message}`;
    } finally {
      settleContainer(task.id);
    }
  }

  // Why the task's branch isn't known to be merged into its base branch on
  // origin, or null when it is (or the task has none).
  async function whyUnmerged(task: Task): Promise<string | null> {
    const repository = lifecycle.repositories[task.repo];
    if (!task.worktree || !repository) return null;
    const { id, path, baseBranch } = repository;
    const unchecked = `Couldn’t check whether ${task.id} is merged:`;
    try {
      await git.fetch(path, baseBranch);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return `${unchecked} couldn’t fetch ${baseBranch} from the origin of ${id} (${error.message}).`;
    }
    try {
      if (await git.isMerged(path, task.worktree.branch, `origin/${baseBranch}`)) return null;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return `${unchecked} ${error.message}`;
    }
    return `Not merged into ${baseBranch}: ${task.worktree.branch}’s tip isn’t on origin/${baseBranch}.`;
  }

  // Opens the handoff sheet on how the task's worktree stands now.
  // `quick` when the factory opens it to end a quick launch's grill: the
  // Lifecycle refuses it once the operator has expanded the grill meanwhile.
  function openHandoff(taskId: string, { quick = false } = {}): Promise<Reply> {
    return serially(async (): Promise<Reply> => {
      if (stopping) return { ok: false, reason: 'The daemon is stopping.' };
      const action: LifecycleAction = { type: 'handoffOpened', taskId, readiness: { blockers: [], toCommit: [] }, ...(quick && { quick }) };
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
  async function converse(socket: Socket, runId: string, follows: boolean): Promise<void> {
    const run = lifecycle.runs[runId];
    const task = run && lifecycle.tasks[run.taskId];
    if (!task) return;
    let watchers = conversations.get(runId);
    if (!watchers) conversations.set(runId, (watchers = new Map()));
    const replay = {};
    watchers.set(socket, { replay, follows });
    // Unless only following it, the operator is in the conversation from
    // now: it no longer waits for them.
    publish();
    // Taken now, so a run that ends during the read still has it.
    const live = streamed.get(runId) ?? [];
    // A Done task's conversation is read from its archive.
    const sessionId = run.sessionId ?? task.sessionId;
    const history =
      sessionId && task.worktree ? await executor.history({ sessionId, cwd: task.worktree.path, archive: task.transcripts ?? null }) : [];
    // The client left, or asked again, while the file was read.
    if (watchers.get(socket)?.replay !== replay) return;
    const replayed = new Set(history.map((event) => event.id));
    for (const event of [...history, ...live.filter((event) => !replayed.has(event.id))]) {
      send(socket, { type: 'conversation', runId, event });
    }
    watchers.set(socket, { replay: null, follows });
  }

  function broadcast(runId: string, event: ConversationEvent): void {
    streamed.get(runId)?.push(event);
    for (const [socket, { replay }] of conversations.get(runId) ?? []) {
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
      restartsWhenIdle,
    };
  }

  // An active or suspended run, a queued task (a HITL one Ready for you
  // included, as ADR 0002 says) or an attached TUI.
  // A loop between its iterations does too, and a root waiting on its PR.
  function needsAClock(): boolean {
    const { attachedTuis, activeRuns, suspendedRuns, queuedTasks } = status();
    const waitingOnPrs = Object.values(lifecycle.tasks).filter(waitsOnPr).length;
    return attachedTuis + activeRuns + suspendedRuns + queuedTasks + waitingOnPrs + stepsInFlight.size + cleanupsInFlight.size + reopensInFlight.size + researchInFlight.size + sweepsPending > 0;
  }

  // The Lifecycle changes one action at a time: checking a clone before a run
  // starts waits on git, and nothing may change the Lifecycle meanwhile.
  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(job: () => Promise<T>): Promise<T> {
    const result = queue.then(job);
    queue = result.catch(() => {});
    return result;
  }

  // Before anything else, every run the store still shows live is
  // reconciled (ADR 0003): no run outlives the daemon that started it. After
  // a graceful stop there is none; after a crash, they are flagged unclean.
  // A container whose task's run the store still shows live may hold that
  // run's turn, still going: it is restarted before the run is requeued,
  // and its commits come out (ADR 0003). Docker that can't be reached
  // leaves the daemon knowing of no container.
  void serially(async () => {
    try {
      for (const { taskId, running } of await sandbox.list()) containers.set(taskId, running);
    } catch (error) {
      if (!(error instanceof SandboxError)) throw error;
    }
    for (const run of Object.values(lifecycle.runs)) {
      // Even one Docker didn't list: it may answer by the time the run is prepared.
      if (run.status !== 'ended' && runsInContainer(run)) staleTurns.add(run.taskId);
    }
    for (const taskId of [...staleTurns]) await onContainer(taskId, () => endStaleTurn(taskId)).catch(() => {});
    await settle({ type: 'runsReconciled', interruption: cleanStart ? 'graceful' : 'unclean' }, new Set());
  });

  // Every repository's clone is checked at start (ADR 0010), and the skill
  // set versions finished tasks left behind are removed.
  void serially(async () => {
    await pruneSkillSets();
    for (const [{ id, missing }, reason] of await checkClones(Object.values(lifecycle.repositories))) {
      if (reason) await settle({ type: 'repoMissing', repo: id, reason }, new Set());
      else if (missing) await settle({ type: 'repoFound', repo: id }, new Set([id]));
    }
    // So is whether the App is installed on each, and the skill set set up.
    await checkEveryApp();
    await checkEverySetup();
    // A loop the daemon stopped between iterations carries on, and so do a
    // cleanup, a cancelled task's reopening and a Push & open draft PR it
    // didn't finish, and a research child's publishing. Factory notes a
    // conversation on the operator's turn holds are delivered.
    driveLoops();
    driveCleanups();
    driveReopens();
    drivePublishes();
    driveResearch();
    driveNotes();
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
      if (action.type === 'answer' && allowsByRules(action.permission) && action.permission.allow === 'always') {
        return answerAlways(action.taskId, action.permission);
      }
      const refusal = await settle(action, new Set());
      if (refusal) return { ok: false, reason: refusal };
      if (action.type === 'createTask') return { ok: true, value: { taskId: `T${lifecycle.counters.task}` } };
      return { ok: true };
    });
  }

  // Allow always (ADR 0007): the answer's rules go into the operator's
  // permissions file before the request is answered, so the Lifecycle first
  // checks the answer without applying it. If the rules can't go in, the
  // answer fails with why, and the request stays open. Once they are in, every
  // other open permission request they now cover is answered the same way,
  // and the calls runs hold behind other requests go back to the gate: each
  // the rules cover is let through.
  async function answerAlways(taskId: string, permission: RulesAnswer): Promise<Reply> {
    const answer = { type: 'answer', taskId, permission } as const;
    const { refusal } = reduce(lifecycle, answer, clock.now(), routes(), { holdRuns });
    if (refusal) return { ok: false, reason: refusal };
    const rules = allowedRules(openPermission(lifecycle, lifecycle.tasks[taskId]!)!, permission);
    const problem = addOperatorRules(options.permissionsPath, rules);
    if (problem) return { ok: false, reason: `Allow always added no rules: ${problem}` };
    const refused = await settle(answer, new Set());
    if (refused) return { ok: false, reason: refused };
    for (const request of coveredRequests(lifecycle, readAllowRules(options.permissionsPath).rules)) {
      // Covered, each is answered as surely as the operator's own answer was.
      await settle({ type: 'answer', taskId: request.taskId!, permission: { allow: 'always', rules } }, new Set());
    }
    for (const [runId, calls] of [...held]) {
      held.delete(runId);
      for (const call of calls) gate(runId, call);
    }
    return { ok: true };
  }

  // Applies the action once the clone of every run it starts is in place
  // (ADR 0010). A missing clone first marks its repository missing, which
  // raises one attention request for it, and the action is reduced again
  // without that repository's runs. `inPlace` holds the repositories whose
  // clones were already found in place, so they aren't checked twice.
  async function settle(action: LifecycleAction, inPlace: Set<string>): Promise<string | null> {
    for (;;) {
      const { state, refusal } = reduce(lifecycle, action, clock.now(), routes(), { holdRuns });
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
    driveContainers();
    driveLoops();
    driveCleanups();
    driveReopens();
    drivePublishes();
    driveResearch();
    driveBranchSweeps(before);
    driveNotes();
    driveQuickLaunches();
    restartIfIdle();
  }

  // Restart when idle (ADR 0002): once no run is active, the daemon stops
  // gracefully, and the TUI that asked starts its own build's.
  function restartIfIdle(): void {
    if (restartsWhenIdle && status().activeRuns === 0) void stop();
  }

  // Takes each research child that reported its next step on GitHub (ADR
  // 0007): once per daemon, and again once the operator answers the request
  // a failure raised. Its outcome goes through the Lifecycle like any other event.
  function driveResearch(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      const research = task.child?.research;
      if (!research?.step) continue;
      const key = `${task.id} ${research.step}`;
      if (stopping || researchInFlight.has(key) || (researchStarted.has(key) && research.problem)) continue;
      researchStarted.add(key);
      researchInFlight.add(key);
      void (research.step === 'push' ? pushResearch(task) : closeResearch(task, research.ticket)).then(
        (event) =>
          serially(async () => {
            researchInFlight.delete(key);
            if (!stopping) await settle(event, new Set());
          }),
        (error) => {
          researchInFlight.delete(key);
          throw error;
        },
      );
    }
  }

  // Pushes the research child's `research/<name>` as the App, with a token
  // narrowed to Contents (ADR 0004), and only if its commits touch nothing
  // but `docs/research/**`, which the GitHub port holds to (ADR 0007).
  async function pushResearch(task: Task): Promise<ResearchEvent> {
    const failed = (reason: string): ResearchEvent => ({ type: 'researchFailed', taskId: task.id, step: 'push', reason });
    const repository = lifecycle.repositories[task.repo];
    if (!repository) return failed(`${task.repo} isn’t registered any more.`);
    const unfetched = await fetchBase(git, repository);
    if (unfetched) return failed(unfetched);
    try {
      const { token } = await appToken(task.repo, PUSH);
      const pushed = await github.push(token, { clonePath: repository.path, repo: task.repo, branch: task.worktree!.branch });
      if ('outsideResearch' in pushed) return { type: 'researchPushRefused', taskId: task.id, paths: pushed.outsideResearch };
      // Workflow files are outside docs/research/, so the port refuses them as that first.
      if ('workflowFiles' in pushed) return failed(`${task.worktree!.branch} changes workflow files (${pushed.workflowFiles.join(', ')}), which the factory’s App may not push.`);
      return { type: 'researchPushed', taskId: task.id };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return failed(error.message);
    }
  }

  // Closes the research child's ticket as completed, as the App, with a
  // comment pointing at its research branch and holding its report.
  async function closeResearch(task: Task, ticket: string): Promise<ResearchEvent> {
    try {
      const { token } = await appToken(task.repo, TICKET_WRITE);
      await github.closeIssue(token, ticket, researchComment(task));
      return { type: 'researchClosed', taskId: task.id };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return { type: 'researchFailed', taskId: task.id, step: 'close', reason: error.message };
    }
  }

  // Delivers the factory notes each HITL task holds once its live run is on
  // the operator's turn (ADR 0009): `notesDelivered` sends them.
  function driveNotes(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      if (stopping || !task.factoryNotes?.length || notesInFlight.has(task.id)) continue;
      const run = liveRun(lifecycle, task);
      if (run?.status !== 'active' || run.turn !== 'operator') continue;
      notesInFlight.add(task.id);
      void dispatch({ type: 'notesDelivered', taskId: task.id }).finally(() => notesInFlight.delete(task.id));
    }
  }

  // Ends each quick launch's grill on its handoff sheet once it is done,
  // opened as `openHandoff` opens it.
  function driveQuickLaunches(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      if (stopping || !task.quick?.done || task.handoff || quickInFlight.has(task.id)) continue;
      if (liveRun(lifecycle, task)?.status !== 'active') continue;
      quickInFlight.add(task.id);
      void openHandoff(task.id, { quick: true }).finally(() => quickInFlight.delete(task.id));
    }
  }

  // Sweeps a task's kept child branches (ADR 0011) after each of its runs
  // ends, whatever the run's mode or outcome, and after each of its
  // children's cleanups, which may finish later. One sweep at a time.
  let sweeps: Promise<void> = Promise.resolve();
  let sweepsPending = 0;
  function driveBranchSweeps(before: Lifecycle): void {
    const due = new Set<string>();
    for (const run of Object.values(lifecycle.runs)) {
      const was = before.runs[run.id];
      if (was && was.status !== 'ended' && run.status === 'ended') due.add(run.taskId);
    }
    for (const task of Object.values(lifecycle.tasks)) {
      if (task.parent && before.tasks[task.id]?.cleanup && !task.cleanup) due.add(task.parent);
    }
    for (const taskId of due) {
      sweepsPending++;
      const sweep = sweeps.then(() => sweepChildBranches(taskId));
      sweeps = sweep.then(
        () => {},
        () => {},
      );
      void sweep.finally(() => sweepsPending--);
    }
  }

  // Deletes the task's kept child branches its branch merged (ADR 0011), or,
  // once its root ended, every kept child branch of the tree. A branch that
  // can't be checked or deleted now is tried again at the next sweep, and by
  // its root's cleanup, which says why it fails.
  async function sweepChildBranches(taskId: string): Promise<void> {
    const task = lifecycle.tasks[taskId];
    const repository = task && lifecycle.repositories[task.repo];
    if (stopping || !task || !repository) return;
    const root = rootOf(lifecycle, task);
    const rootEnded = isTerminal(root);
    for (const child of keptChildBranches(rootEnded ? subtree(lifecycle, root).slice(1) : childrenOf(lifecycle, task))) {
      const { branch } = child.worktree!;
      try {
        if (!rootEnded && !(task.worktree && (await git.isMerged(repository.path, branch, task.worktree.branch)))) continue;
        await git.deleteBranch(repository.path, branch);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        continue;
      }
      await serially(async () => {
        if (!stopping) await settle({ type: 'childBranchDeleted', taskId: child.id }, new Set());
      });
    }
  }

  // Takes each root's Push & open draft PR its next step (ADR 0007): once per
  // daemon, and again once the operator answers the request a failure
  // raised. Its outcome goes through the Lifecycle like any other event.
  function drivePublishes(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      if (!task.publishing) continue;
      const key = `${task.id} ${task.publishing.step}`;
      if (stopping || publishesInFlight.has(key) || (publishesStarted.has(key) && task.publishing.problem)) continue;
      publishesStarted.add(key);
      publishesInFlight.add(key);
      void (task.publishing.step === 'push' ? pushBranch(task) : openPr(task)).then(
        (event) =>
          serially(async () => {
            publishesInFlight.delete(key);
            if (!stopping) await settle(event, new Set());
          }),
        (error) => {
          publishesInFlight.delete(key);
          throw error;
        },
      );
    }
  }

  // Pushes the root's task branch as the App, with a token minted for this
  // write alone and narrowed to Contents (ADR 0004), under the fixed refspec
  // the GitHub port holds to. The base branch is fetched first, so what the
  // base already has on GitHub doesn't count as this push's workflow changes.
  async function pushBranch(task: Task): Promise<PublishEvent> {
    const failed = (reason: string): PublishEvent => ({ type: 'publishFailed', taskId: task.id, step: 'push', reason });
    const repository = lifecycle.repositories[task.repo];
    if (!repository) return failed(`${task.repo} isn’t registered any more.`);
    const unfetched = await fetchBase(git, repository);
    if (unfetched) return failed(unfetched);
    try {
      const { token } = await appToken(task.repo, PUSH);
      const pushed = await github.push(token, { clonePath: repository.path, repo: task.repo, branch: task.worktree!.branch });
      if ('workflowFiles' in pushed) return { type: 'pushRefused', taskId: task.id, workflowFiles: pushed.workflowFiles };
      // A task branch is never a research branch.
      if ('outsideResearch' in pushed) return failed(`${task.worktree!.branch} isn’t a task branch.`);
      return { type: 'branchPushed', taskId: task.id, commit: pushed.pushed };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return failed(error.message);
    }
  }

  // Opens the root's draft PR as the App, with a token minted for this write
  // alone, assigned to the operator, the App's owner (ADR 0004).
  async function openPr(task: Task): Promise<PublishEvent> {
    const failed = (reason: string): PublishEvent => ({ type: 'publishFailed', taskId: task.id, step: 'open-pr', reason });
    const repository = lifecycle.repositories[task.repo];
    if (!repository) return failed(`${task.repo} isn’t registered any more.`);
    try {
      const { token } = await appToken(task.repo, OPEN_PR);
      // `appToken` found the App.
      const assignee = await github.appOwner((await factoryApp())!);
      const { title, body } = pullRequestOf(lifecycle, task);
      const pr = await github.openDraftPr(token, { repo: task.repo, head: task.worktree!.branch, base: repository.baseBranch, title, body, assignee });
      return { type: 'prOpened', taskId: task.id, pr };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return failed(error.message);
    }
  }

  // Reopens each ticket a cancelled task closed (ADR 0006): once per daemon,
  // and again once the operator answers the request a failure raised. Its
  // outcome goes through the Lifecycle like any other event.
  function driveReopens(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      for (const ticket of task.reopening?.tickets ?? []) {
        const key = `${task.id} ${ticket}`;
        if (stopping || reopensInFlight.has(key) || (reopensStarted.has(key) && task.reopening!.problem)) continue;
        reopensStarted.add(key);
        reopensInFlight.add(key);
        void reopenTicket(task, ticket).then(
          (event) =>
            serially(async () => {
              reopensInFlight.delete(key);
              if (!stopping) await settle(event, new Set());
            }),
          (error) => {
            reopensInFlight.delete(key);
            throw error;
          },
        );
      }
    }
  }

  // Reopens a ticket the cancelled task closed, as the App, with a token
  // minted for this write alone (ADR 0004), and a comment saying its work
  // wasn't merged.
  async function reopenTicket(task: Task, ticket: string): Promise<ReopenEvent> {
    try {
      const { token } = await appToken(task.repo, TICKET_WRITE);
      await github.reopenIssue(token, ticket, reopeningComment(task));
      return { type: 'ticketReopened', taskId: task.id, ticket };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return { type: 'ticketUnreopened', taskId: task.id, ticket, reason: error.message };
    }
  }

  // Cleans up after each ended task whose cleanup is pending (ADR 0011), once
  // per daemon. Its outcome goes through the Lifecycle like any other event.
  function driveCleanups(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      if (stopping || !task.cleanup || cleanupsStarted.has(task.id)) continue;
      cleanupsStarted.add(task.id);
      cleanupsInFlight.add(task.id);
      void cleanUp(task).then(
        (event) =>
          serially(async () => {
            cleanupsInFlight.delete(task.id);
            if (!stopping) await settle(event, new Set());
          }),
        (error) => {
          cleanupsInFlight.delete(task.id);
          throw error;
        },
      );
    }
  }

  // Archives every session transcript of the task, then removes its worktree
  // and, unless Keep branch kept it, force-deletes its local task branch: a
  // squash merge fails `git branch -d`, and Mark done either found the branch
  // merged or the operator chose to finish anyway, while Cancel deletes it
  // only when no work would be lost or the operator chose Discard work.
  // Nothing is removed unless every transcript is archived. Each step can be
  // done again.
  async function cleanUp(task: Task): Promise<CleanupEvent> {
    const { path, branch } = task.worktree!;
    const failed = (reason: string): CleanupEvent => ({ type: 'cleanupFailed', taskId: task.id, reason });
    const transcripts = join(options.transcriptsRoot, task.id);
    try {
      for (const sessionId of sessionsOf(lifecycle, task)) await executor.archive({ sessionId, cwd: path }, transcripts);
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
      return failed(`The factory couldn’t archive ${task.id}’s transcripts, so it removed nothing yet: ${error.message}`);
    }
    const repository = lifecycle.repositories[task.repo];
    if (!repository) return failed(`${task.repo} isn’t registered any more, so ${task.id}’s worktree at ${path} stays.`);
    const unretired = await retireContainer(task);
    if (unretired) return failed(unretired);
    // A root's tree goes with it: each child branch kept to merge, merged or
    // not (ADR 0011). One whose child's own cleanup is still under way is
    // left to the sweep after it.
    const childBranches = task.parent ? [] : keptChildBranches(subtree(lifecycle, task).slice(1));
    try {
      await git.removeWorktree(repository.path, path);
      if (!task.cleanup?.keepBranch) await git.deleteBranch(repository.path, branch);
      for (const child of childBranches) await git.deleteBranch(repository.path, child.worktree!.branch);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const branches = [...(task.cleanup?.keepBranch ? [] : [branch]), ...childBranches.map((child) => child.worktree!.branch)];
      const what = branches.length ? `worktree at ${path} and the branches ${branches.join(', ')}` : `worktree at ${path}`;
      return failed(`The factory couldn’t remove ${task.id}’s ${what}: ${error.message}`);
    }
    // What the root left on GitHub goes as the App (ADR 0011): a cancelled
    // root's draft PR is closed, then its remote task branch deleted.
    const remote = task.cleanup?.remote;
    if (remote) {
      const { branch: pushed, prToClose } = remote;
      const what = prToClose === null ? `delete ${pushed}` : `close PR #${prToClose} and delete ${pushed}`;
      const problem = await asApp(what, async () => {
        if (prToClose !== null) await github.closePr((await appToken(task.repo, PR_WRITE)).token, prRef(task.repo, prToClose), closingPrComment(task));
        await github.deleteBranch((await appToken(task.repo, PUSH)).token, task.repo, pushed);
      });
      if (problem) return failed(problem);
    }
    return { type: 'cleanedUp', taskId: task.id, transcripts, childBranches: childBranches.map((child) => child.id) };
  }

  // Starts the step on GitHub of each loop between its iterations (ADR 0006):
  // picking the next ticket, pushing the task branch at L2 with what the last
  // iteration did (ADR 0007), or closing that iteration's ticket; and
  // of each work loop between its tickets (ADR 0012): reading its map. Its outcome goes
  // through the Lifecycle like any other event.
  function driveLoops(): void {
    for (const task of Object.values(lifecycle.tasks)) {
      if (stopping || stepsInFlight.has(task.id)) continue;
      // A pick starts the next iteration's run, which waits for the next
      // daemon while this one starts none.
      if (holdRuns && !readingMap(lifecycle, task) && task.loop?.step === 'pick') continue;
      const step = readingMap(lifecycle, task)
        ? readMap(task)
        : betweenIterations(lifecycle, task)
          ? task.loop!.step === 'pick' ? pickTicket(task) : task.loop!.step === 'push' ? pushIteration(task) : closeTicket(task)
          : null;
      if (!step) continue;
      stepsInFlight.add(task.id);
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

  // Picks a Ralph loop's next ticket: reads its ticket set, with the task
  // branch's tip the iteration starts from.
  async function pickTicket(task: Task): Promise<LoopEvent> {
    try {
      const tickets = await readTicketSet(task);
      const { head } = await git.snapshot(task.worktree!.path);
      return { type: 'ticketsRead', taskId: task.id, tickets, base: head, sessionId: randomUUID() };
    } catch (error) {
      if (!isGitHubFailure(error) && !(error instanceof GitError)) throw error;
      return { type: 'ticketsUnread', taskId: task.id, reason: error.message };
    }
  }

  // Reads a work loop's map: its tickets, for the frontier the operator picks from.
  async function readMap(task: Task): Promise<LoopEvent> {
    try {
      return { type: 'mapRead', taskId: task.id, tickets: await readTicketSet(task), sessionId: randomUUID() };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return { type: 'ticketsUnread', taskId: task.id, reason: error.message };
    }
  }

  // Reads the task's ticket set from GitHub with a read-only token, in
  // order: each source's sub-issues, or a ticket source itself when it has
  // none. A spec or a map is never a ticket itself.
  async function readTicketSet(task: Task): Promise<Issue[]> {
    const { token } = await appToken(task.repo, READ_ONLY);
    const { kind, refs: sources } = ticketSources(lifecycle, task)!;
    const refs: string[] = [];
    for (const source of sources) {
      const subIssues = await github.subIssues(token, source);
      for (const ref of subIssues.length || kind !== 'tickets' ? subIssues : [source]) if (!refs.includes(ref)) refs.push(ref);
    }
    const tickets: Issue[] = [];
    for (const ref of refs) tickets.push(await github.readIssue(token, ref));
    return tickets;
  }

  // Pushes the task branch with the last L2 iteration's commits as the App,
  // with a token narrowed to Contents (ADR 0004), before its ticket closes
  // (ADR 0006). Like Push & open draft PR's push, it fetches the base first.
  async function pushIteration(task: Task): Promise<LoopEvent> {
    const ticket = task.loop!.ticket!;
    const { branch } = task.worktree!;
    const failed = (reason: string): LoopEvent => ({ type: 'iterationUnpushed', taskId: task.id, ticket, reason });
    const repository = lifecycle.repositories[task.repo];
    if (!repository) return failed(`${task.repo} isn’t registered any more.`);
    const unfetched = await fetchBase(git, repository);
    if (unfetched) return failed(unfetched);
    try {
      const { token } = await appToken(task.repo, PUSH);
      const pushed = await github.push(token, { clonePath: repository.path, repo: task.repo, branch });
      if ('workflowFiles' in pushed) {
        return failed(`${branch} changes workflow files (${pushed.workflowFiles.join(', ')}), which the factory’s App may not push: push it by hand (\`git push origin ${branch}\`).`);
      }
      // A task branch is never a research branch.
      if ('outsideResearch' in pushed) return failed(`${branch} isn’t a task branch.`);
      return { type: 'iterationPushed', taskId: task.id, ticket };
    } catch (error) {
      if (!isGitHubFailure(error)) throw error;
      return failed(error.message);
    }
  }

  // Closes the ticket the last iteration did as completed, as the App, with
  // a token minted for this write alone (ADR 0004), and a comment saying
  // where its work is.
  async function closeTicket(task: Task): Promise<LoopEvent> {
    const { ticket, commits } = task.loop! as { ticket: string; commits: string[] };
    try {
      const { token } = await appToken(task.repo, TICKET_WRITE);
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
    // Ended first: a run starting in the same task waits for what its
    // container does about the run cut short.
    for (const run of Object.values(lifecycle.runs)) {
      const was = before.runs[run.id];
      if (was && was.status !== 'ended' && run.status === 'ended') {
        // The runs the store showed live at start are the dead daemon's: recovery restarted their containers.
        const startedHere = streamed.delete(run.id);
        held.delete(run.id);
        // A run ended by an operator verb or parked isn't checked: it never finished.
        unguard(run.id);
        const ownEvent = 'runId' in action && action.runId === run.id;
        if (!ownEvent) executor.stop(run.id);
        // Killing `docker exec` leaves the turn running in the container (ADR
        // 0003), and a run that failed may have lost its `docker exec` first.
        // One whose guards broke ended its turn, and keeps its commits there.
        const brokeGuards = brokenRuns.delete(run.id);
        if (startedHere && runsInContainer(run) && containers.has(run.taskId) && (!ownEvent || (action.type === 'runFailed' && !brokeGuards))) {
          staleTurns.add(run.taskId);
          settleContainer(run.taskId);
        }
      }
    }
    for (const run of Object.values(lifecycle.runs)) {
      if (!before.runs[run.id] && run.status === 'active') {
        streamed.set(run.id, []);
        void startRun(run);
      }
    }
    // The conversation verbs act on the task's live run.
    const conversing = 'taskId' in action ? lifecycle.tasks[action.taskId] : undefined;
    const run = conversing && liveRun(lifecycle, conversing);
    // A message reaches the run on the operator's turn, or once the agent's
    // turn it was sent during ends, with whatever else waited.
    if (action.type === 'sendMessage') {
      if (before.runs[run!.id]!.turn === 'operator') executor.send(run!.id, action.text);
    } else if (action.type === 'notesDelivered') {
      executor.send(run!.id, before.tasks[action.taskId]!.factoryNotes!.join('\n\n'));
    } else if (action.type === 'interrupt') {
      executor.interrupt(run!.id);
    } else if (action.type === 'answerQuestion') {
      executor.answer(run!.id, action.questionId, action.answers);
    } else if (action.type === 'answer' && openCard(before, before.tasks[action.taskId]!)) {
      // A HITL run's card: its call gets the operator's verdict, then the
      // calls it held go to the gate in turn.
      const asking = liveRun(before, before.tasks[action.taskId]!)!;
      executor.permit(asking.id, asking.permission!.id, verdictOf(action.permission!));
      const waiting = held.get(asking.id) ?? [];
      held.delete(asking.id);
      for (const call of waiting) gate(asking.id, call);
    } else if (action.type === 'answer') {
      // A suspended run's question gets its answers as the card's would, and
      // its tool call the operator's verdict.
      const request = openRequest(before, before.tasks[action.taskId]!)!;
      if (request.holdsRun && request.question) executor.answer(request.runId!, request.question.id, action.answers!);
      if (request.holdsRun && request.permission) executor.permit(request.runId!, request.permission.id, verdictOf(action.permission!));
      // The run is back: the calls it held go to the gate in turn.
      const waiting = request.holdsRun ? (held.get(request.runId!) ?? []) : [];
      held.delete(request.runId!);
      for (const call of waiting) gate(request.runId!, call);
    } else if (action.type === 'permissionAsked') {
      // Unless it raised a request or a card, the operator's earlier answers allowed the call.
      const { taskId } = lifecycle.runs[action.runId]!;
      if (openPermission(lifecycle, lifecycle.tasks[taskId]!)?.id !== action.call.id) executor.permit(action.runId, action.call.id, { allow: true });
    } else if (action.type === 'handoffOpened' && run) {
      // A run started for the brief opens on the request itself.
      const was = before.runs[run.id];
      if (was?.turn === 'operator' && run.turn === 'agent') executor.send(run.id, BRIEF_REQUEST);
      else if (was?.turn === 'agent' && !before.tasks[action.taskId]!.handoff) executor.interrupt(run.id);
    } else if (action.type === 'turnEnded') {
      // The calls a HITL run's card held ended with its turn.
      if (lifecycle.runs[action.runId]!.mode === 'HITL') held.delete(action.runId);
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
  // An L2 run starts in its task's container (ADR 0007), prepared with the
  // host task branch's commits, and its checks are made there. Any run of a
  // task with a container waits for what the container is doing first, such
  // as bringing out the commits of a run cut short.
  async function startRun(run: Run): Promise<void> {
    const task = lifecycle.tasks[run.taskId]!;
    const cwd = task.worktree?.path ?? null;
    let guards: RunGuards | null = null;
    let container: Container | null = null;
    let token: string | null = null;
    if (containers.has(task.id)) await onContainer(task.id, async () => {});
    if (run.mode === 'AFK' && cwd) {
      const fail = (reason: string) => void dispatch({ type: 'runFailed', runId: run.id, reason });
      const l2 = run.autonomy === 'L2';
      if (l2) {
        try {
          token = await secrets.read(SUBSCRIPTION_TOKEN_SECRET);
        } catch (error) {
          if (!(error instanceof SecretsError)) throw error;
          return fail(`The factory couldn’t read the subscription token L2 runs use: ${error.message}`);
        }
        if (!token) return fail(NO_SUBSCRIPTION_TOKEN);
      }
      let snapshot: RunSnapshot | null = null;
      if (!l2) {
        try {
          snapshot = await git.snapshot(cwd);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          return fail(`The factory couldn't read the run's worktree at ${cwd}: ${error.message}`);
        }
      }
      // The run reads GitHub as the App, never as the operator (ADR 0004).
      let bot: BotToken;
      try {
        bot = await botToken(task.repo);
      } catch (error) {
        if (!isGitHubFailure(error)) throw error;
        return fail(`The factory couldn’t give the run its read-only GitHub token: ${error.message}`);
      }
      if (lifecycle.runs[run.id]?.status !== 'active') return;
      // An L2 run's are where its container mounts them, read-only.
      const dir = l2 ? containerRunDir(task.id) : join(options.runsRoot, run.id);
      if (l2) {
        try {
          container = await prepareContainer(task, run, dir);
          snapshot = await container.checks.snapshot(container.workdir);
        } catch (error) {
          if (!(error instanceof SandboxError || error instanceof GitError)) throw error;
          return fail(`The factory couldn’t prepare ${task.id}’s container: ${error.message}`);
        }
        // Ended while its container was prepared: the container is settled again.
        if (lifecycle.runs[run.id]?.status !== 'active') return settleContainer(task.id);
      }
      // The run's git keeps the settings its worktree was checked out under:
      // the operator's on the host, the image's in a container.
      const env = prepareRunGit(dir, FACTORY_IDENTITY, { task: task.id, run: run.id, model: run.model }, snapshot!.checkout);
      const ghConfigDir = join(dir, 'gh');
      Object.assign(env, writeRunGh(ghConfigDir, bot.user, bot.token));
      guarded.set(run.id, { worktree: container?.workdir ?? cwd, host: cwd, dir, checks: container?.checks ?? git, container, snapshot: snapshot!, scripts: new Set() });
      botTokens.set(run.id, { repo: task.repo, dir: ghConfigDir, refreshAt: bot.expiresAt - TOKEN_REFRESH_MS });
      guards = { start: snapshot!.head, env: l2 ? inRunDir(env, dir) : env };
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
      // The scheduler's choice (ADR 0001): an L2 run's token goes into its container alone.
      credential: container ? 'subscription-token' : 'subscription-host',
      token,
      container,
      plugin: run.skillSet ? skillSets.pathOf(run.skillSet) : null,
      guards,
      // Claude Code matches them itself, so most calls never reach the gate.
      allowRules: run.mode === 'AFK' ? readAllowRules(options.permissionsPath).rules : [],
      reports: runReports(task, run),
      child: !!task.child,
      spawns: spawnsWithinDepth(lifecycle, task),
    };
    executor.start(start, {
      // A session is named for each completed run now, in case the next
      // stage's context is fresh, as it is for `advanceStage`.
      report: (event) =>
        void checkedAfterRun(event).then((checked) => dispatch(checked.type === 'runCompleted' ? { ...checked, sessionId: randomUUID() } : checked)),
      converse: (event) => broadcast(run.id, event),
      askPermission: (call) => gate(run.id, call),
      delegate: (request) => delegate(run.id, request),
    });
  }

  // An agent's delegation tool call (ADR 0009): what it asks about its own
  // children, answered from the Lifecycle. A refusal is the agent's to read,
  // and raises no attention request.
  function delegate(runId: string, request: Delegation): Promise<DelegationReply> {
    switch (request.type) {
      case 'spawnChild':
        return spawnChild(runId, request);
      case 'listChildren':
        return serially(async (): Promise<DelegationReply> => {
          const task = lifecycle.tasks[lifecycle.runs[runId]?.taskId ?? ''];
          if (!task) return { ok: false, error: `There is no run ${runId}.` };
          const children = childrenOf(lifecycle, task).map(childListing);
          return { ok: true, text: children.length ? JSON.stringify(children, null, 2) : 'You have spawned no children.' };
        });
      case 'cancelChild':
        return dispatch({ type: 'childCancelled', runId, childId: request.id }).then((reply) =>
          reply.ok ? { ok: true, text: `Cancelled ${request.id}, with every task it spawned.` } : { ok: false, error: reply.reason },
        );
    }
  }

  // Spawns a child of the run's task (ADR 0009): checked against the tree
  // limits first, then its branch `<task-branch>--c<n>` is cut from the
  // parent's tip into its own worktree, and the child queues for a slot
  // with the `child` preset frozen. A research child's `research/<name>` is
  // cut from the fetched base branch instead, so nothing of the parent's
  // branch rides along when the factory pushes it (ADR 0007). A replay of
  // the same tool call returns the child it spawned.
  function spawnChild(runId: string, request: Extract<Delegation, { type: 'spawnChild' }>): Promise<DelegationReply> {
    return serially(async (): Promise<DelegationReply> => {
      if (stopping) return { ok: false, error: 'The daemon is stopping.' };
      const replayed = childSpawnedBy(lifecycle, runId, request.toolUseId);
      if (replayed) return { ok: true, text: spawnedText(replayed) };
      const goal = typeof request.goal === 'string' ? request.goal : '';
      const parentTask = lifecycle.tasks[lifecycle.runs[runId]?.taskId ?? ''];
      if (!parentTask) return { ok: false, error: `There is no run ${runId}.` };
      let research: ChildSpawned['research'] = null;
      if (request.research) {
        const refs = issueRefs([String(request.research.ticket).trim()], parentTask.repo);
        if ('error' in refs) return { ok: false, error: refs.error };
        research = { ticket: refs.issues[0]!, name: String(request.research.name).trim() };
      }
      const action: ChildSpawned = {
        type: 'childSpawned',
        runId,
        toolUseId: request.toolUseId,
        title: titleFrom(goal),
        goal,
        skill: request.skill?.trim() || null,
        tier: request.tier ?? null,
        autonomy: request.autonomy ?? null,
        // The Lifecycle defaults it by the run's mode (ADR 0009).
        awaited: request.await ?? null,
        research,
        // Filled once the limits allow it.
        preset: null!,
        worktree: { branch: '', path: '' },
        base: '',
        sessionId: randomUUID(),
      };
      const refused = guard(lifecycle, action);
      if (refused) return { ok: false, error: refused };
      const parent = lifecycle.tasks[lifecycle.runs[runId]!.taskId]!;
      const repository = lifecycle.repositories[parent.repo]!;
      // A skill the parent's skill set lacks is the agent's to fix now, not the child's to fail on.
      if (action.skill && parent.skillSet && !(await skillSets.skills(parent.skillSet)).includes(action.skill)) {
        return { ok: false, error: `The skill set has no skill ${action.skill}: name one it has, or none to send the goal as it is.` };
      }
      const presets = await presetsOf(repository);
      if ('error' in presets) return { ok: false, error: presets.error };
      const resolved = resolvePreset(presets.files, CHILD_PRESET);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      action.preset = { ...resolved.preset, repoCommit: presets.commit };
      const childId = nextTaskId(lifecycle);
      action.worktree = research
        ? researchWorktree(options.worktreeRoot, repository, childId, research.name)
        : childWorktree(options.worktreeRoot, repository, parent.worktree!, childId, childrenOf(lifecycle, parent).length + 1);
      try {
        if (research) {
          const unfetched = await fetchBase(git, repository);
          if (unfetched) return { ok: false, error: `The factory couldn’t cut ${action.worktree.branch} for the child: ${unfetched}` };
          await git.addWorktree(repository.path, { ...action.worktree, startPoint: `origin/${repository.baseBranch}` });
          action.base = (await git.snapshot(action.worktree.path)).head;
        } else {
          // An L2 parent's commits are in its container: the child is cut from its tip there.
          if (containers.get(parent.id)) await onContainer(parent.id, () => sandbox.bringOut(parent.id, parent.worktree!.path, parent.worktree!.branch));
          action.base = (await git.snapshot(parent.worktree!.path)).head;
          await git.addWorktree(repository.path, { ...action.worktree, startPoint: action.base });
        }
      } catch (error) {
        if (!(error instanceof GitError || error instanceof SandboxError)) throw error;
        return { ok: false, error: `The factory couldn’t cut ${action.worktree.branch} for the child: ${error.message}` };
      }
      const refusal = await settle(action, new Set());
      if (refusal) {
        // No child holds them: the worktree and branch just cut go again.
        await git.removeWorktree(repository.path, action.worktree.path).catch(() => {});
        await git.deleteBranch(repository.path, action.worktree.branch).catch(() => {});
        return { ok: false, error: refusal };
      }
      return { ok: true, text: spawnedText(lifecycle.tasks[childId]!) };
    });
  }

  // The run event, failed when it ends a guarded run that broke the git
  // invariants of its snapshot (ADR 0007), saying what broke.
  async function checkedAfterRun(event: RunEvent): Promise<RunEvent> {
    const guard = guarded.get(event.runId);
    if (!guard || (event.type !== 'runCompleted' && event.type !== 'runFailed')) return event;
    unguard(event.runId);
    // What the run's container denied it is logged on the run, whatever else it did.
    if (guard.container) {
      const deniedHosts = await guard.container.deniedHosts().catch((error) => {
        if (!(error instanceof SandboxError)) throw error;
        return [];
      });
      if (deniedHosts.length) event = { ...event, deniedHosts };
    }
    // The factory's own branches for other tasks, cut while the run worked.
    const branches = Object.values(lifecycle.tasks).flatMap((task) =>
      task.worktree && task.worktree.path !== guard.worktree ? [task.worktree.branch] : [],
    );
    let broken: string[];
    try {
      // The container's clone has no other task's branches.
      broken = await guard.checks.violations(guard.worktree, guard.snapshot, guard.container ? [] : branches, FACTORY_IDENTITY.email);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      broken = [`The factory couldn't check the run's worktree: ${error.message}`];
    }
    // A run in a container that kept the guards hands its commits to the
    // host task branch, as a fast-forward through a bundle.
    if (broken.length === 0 && guard.container) {
      const { taskId } = guard.container;
      const { branch } = lifecycle.tasks[taskId]!.worktree!;
      try {
        await onContainer(taskId, () => sandbox.bringOut(taskId, guard.host, branch));
      } catch (error) {
        if (!(error instanceof SandboxError)) throw error;
        const unbrought = `the factory couldn’t bring its commits out of ${taskId}’s container: ${error.message}`;
        return event.type === 'runCompleted'
          ? { type: 'runFailed', runId: event.runId, reason: `The run completed, but ${unbrought}` }
          : { ...event, reason: `${event.reason} Then ${unbrought}` };
      }
    }
    if (broken.length === 0) return event.type === 'runCompleted' ? withCommits(event, guard.host) : event;
    brokenRuns.add(event.runId);
    const breach = `broke the factory’s git guards. ${broken.join(' ')}`;
    return event.type === 'runCompleted'
      ? { type: 'runFailed', runId: event.runId, reason: `The run ${breach}` }
      : { ...event, reason: `${event.reason} It also ${breach}` };
  }

  // A Ralph loop iteration's completion, with the commits on the task branch
  // since its iteration began, by which the Lifecycle judges it (ADR 0006).
  async function withCommits(event: Extract<RunEvent, { type: 'runCompleted' }>, worktree: string): Promise<RunEvent> {
    const run = lifecycle.runs[event.runId];
    const task = run && lifecycle.tasks[run.taskId];
    // A child's are those on its branch since it was cut, for its report.
    const base = run?.ticket ? task!.loop?.base : task?.child?.base;
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
    const guard = guarded.get(runId);
    if (!guard) return;
    guarded.delete(runId);
    // A container's run directory stays mounted until the container goes.
    if (!guard.container) rmSync(guard.dir, { recursive: true, force: true, maxRetries: 3 });
  }

  // The task's container's run directory on the host, mounted read-only in it.
  function containerRunDir(taskId: string): string {
    return join(options.runsRoot, 'containers', taskId);
  }

  // Runs `job` on the task's container once what the daemon already does to
  // it is done: one step at a time.
  function onContainer<T>(taskId: string, job: () => Promise<T>): Promise<T> {
    const result = (containerJobs.get(taskId) ?? Promise.resolve()).then(job);
    containerJobs.set(taskId, result.catch(() => {}));
    return result;
  }

  // The run's task's container, running, with the host task branch's
  // commits in it, and the branches of the children it awaits to merge.
  function prepareContainer(task: Task, run: Run, runDir: string): Promise<Container> {
    const { path, branch } = task.worktree!;
    const branches = childrenOf(lifecycle, task)
      .filter((child) => child.child?.awaited && !child.child.research && !child.child.branchDeleted && child.worktree)
      .map((child) => child.worktree!.branch);
    return onContainer(task.id, async () => {
      // No run starts beside a turn that may still run there.
      if (staleTurns.has(task.id)) await endStaleTurn(task.id);
      let sessionsDir: string;
      try {
        sessionsDir = executor.sessionsDir(path);
      } catch (error) {
        throw new SandboxError((error as Error).message);
      }
      const plugin = run.skillSet ? skillSets.pathOf(run.skillSet) : null;
      const egress = egressFor(task.egressHosts ?? []);
      const container = await sandbox.prepare({ taskId: task.id, clonePath: lifecycle.repositories[task.repo]!.path, branch, branches, plugin, runDir, sessionsDir, egress });
      containers.set(task.id, true);
      return container;
    });
  }

  // Settles each container the daemon knows of.
  function driveContainers(): void {
    for (const taskId of containers.keys()) settleContainer(taskId);
  }

  // Brings the task's container to what its task needs (ADR 0011), once
  // what the daemon already does to it is done: a turn the daemon cut short
  // dies with a restart, and its commits come out to the host task branch
  // (ADR 0003); then a container whose task has no live run there stops. A
  // step that fails is tried again the next time the Lifecycle changes.
  function settleContainer(taskId: string): void {
    if (settling.has(taskId)) return;
    settling.add(taskId);
    void onContainer(taskId, async () => {
      settling.delete(taskId);
      try {
        if (staleTurns.has(taskId)) await endStaleTurn(taskId);
        const task = lifecycle.tasks[taskId];
        const run = task && liveRun(lifecycle, task);
        // A run starting there prepares it; one that ends before it does settles it again.
        const inUse = !!run && runsInContainer(run);
        if (!inUse && containers.get(taskId)) {
          await sandbox.stop(taskId);
          containers.set(taskId, false);
        }
      } catch (error) {
        if (!(error instanceof SandboxError)) throw error;
      }
    });
  }

  // Restarts the task's container, which kills a turn still running in it
  // and keeps its clone, then brings its commits out to the host task branch.
  // Until the restart is made, the turn may still run: the next run's
  // prepare tries it again first.
  async function endStaleTurn(taskId: string): Promise<void> {
    const had = await sandbox.restart(taskId);
    staleTurns.delete(taskId);
    if (!had) return void containers.delete(taskId);
    containers.set(taskId, true);
    const worktree = lifecycle.tasks[taskId]?.worktree;
    if (!worktree) return;
    // Commits that can't come out stay in the container: the next run's
    // prepare, or the task's cleanup, says why.
    await sandbox.bringOut(taskId, worktree.path, worktree.branch).catch((error) => {
      if (!(error instanceof SandboxError)) throw error;
    });
  }

  // At the task's end (ADR 0011): its container's commits come out to the
  // host task branch in a final bundle, and then the container goes, with
  // its run directory. Null once done, or why it couldn't be.
  function retireContainer(task: Task): Promise<string | null> {
    const ranInOne = containers.has(task.id) || task.runIds.some((id) => runsInContainer(lifecycle.runs[id]!));
    if (!ranInOne) return Promise.resolve(null);
    return onContainer(task.id, async () => {
      try {
        if ((await sandbox.list()).some((listed) => listed.taskId === task.id)) {
          await sandbox.start(task.id);
          await sandbox.bringOut(task.id, task.worktree!.path, task.worktree!.branch);
          await sandbox.remove(task.id);
        }
      } catch (error) {
        if (!(error instanceof SandboxError)) throw error;
        return `The factory couldn’t bring ${task.id}’s last commits out of its container and remove it, so it removed nothing yet: ${error.message}`;
      }
      containers.delete(task.id);
      rmSync(containerRunDir(task.id), { recursive: true, force: true, maxRetries: 3 });
      return null;
    });
  }

  // The L1 gate (ADR 0007), for the calls Claude Code still asks about once
  // it has matched the rules the run started with. A HITL run's calls go
  // through it too, and ask with a card in its conversation instead of a
  // permission request (`run.permission`). A call the factory's allow
  // list or the operator's permissions file covers runs at once. The file is
  // read afresh for every call, so a rule the operator adds holds from their
  // next one, even in a run already under way. The Lifecycle decides the
  // parts they leave uncovered: by the operator's earlier answers, or with a
  // permission request. A call asked about while another request or card
  // holds its run is held until that one is answered; one the Lifecycle won't ask about
  // otherwise is refused, with its reason. The run's later calls may run the
  // temp scripts a call the rules cover writes, but none a call overwrote.
  function gate(runId: string, call: ToolCall): void {
    const { rules, error } = readAllowRules(options.permissionsPath);
    const guard = guarded.get(runId);
    // A HITL run is unguarded, but works in its task's worktree all the same.
    const worktree = guard?.worktree ?? lifecycle.tasks[lifecycle.runs[runId]?.taskId ?? '']?.worktree?.path ?? null;
    const parts = uncovered(rules, call, worktree, guard?.scripts);
    if (guard) trackScripts(call, guard.scripts, parts.length === 0);
    if (parts.length === 0) {
      return executor.permit(runId, call.id, { allow: true });
    }
    void dispatch({ type: 'permissionAsked', runId, call, parts, rulesProblem: error }).then((reply) => {
      if (reply.ok) return;
      const run = lifecycle.runs[runId];
      if (run?.status === 'suspended' || (run?.status === 'active' && run.permission)) held.set(runId, [...(held.get(runId) ?? []), call]);
      else executor.permit(runId, call.id, { allow: false, message: reply.reason });
    });
  }

  // The runs whose conversations some TUI has open, not only following their output.
  function watched(): Set<string> {
    return new Set([...conversations].filter(([, watchers]) => [...watchers.values()].some(({ follows }) => !follows)).map(([runId]) => runId));
  }

  function publish(): void {
    const next = toFactoryState(lifecycle, watched(), clock.now());
    const ops = diffFactoryState(published, next);
    published = next;
    if (ops.length) for (const socket of subscribers) send(socket, { type: 'patch', ops });
  }

  // A graceful stop ends every live run first (ADR 0002): an active AFK run
  // is requeued, losing its in-flight turn, and the rest are parked. The
  // next daemon starts what is queued.
  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopTicking();
      holdRuns = 'The daemon is stopping, so it starts no new run.';
      await serially(() => settle({ type: 'runsReconciled', interruption: 'graceful' }, new Set()));
      // A container whose run was cut short is restarted, its commits come out, and it stops.
      await Promise.all(containerJobs.values());
      // Written before the pipe is let go: the next daemon may start as soon
      // as it is, and must find the marker. Nothing after it starts a run.
      store.markCleanShutdown();
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
const NO_SUBSCRIPTION_TOKEN =
  'The factory has no subscription token for L2 runs yet: run `claude setup-token`, then `agents-factory setup token` to store what it prints.';

// Whether the run executes in its task's container: an L2 AFK run (ADR 0007).
function runsInContainer(run: Run): boolean {
  return run.mode === 'AFK' && run.autonomy === 'L2';
}

// What the factory holds about a guarded AFK run while it runs (ADR 0007):
// where its checks are made (`worktree`, the container's workdir for an L2
// run) and how, its task's host worktree, its own directory of git config,
// hooks and gh config, its container if it runs in one, its snapshot from
// before it started, and the temp scripts the gate let it write.
type Guarded = {
  worktree: string;
  host: string;
  dir: string;
  checks: Pick<Git, 'snapshot' | 'violations'>;
  container: Container | null;
  snapshot: RunSnapshot;
  scripts: Set<string>;
};

// What the executor hands a call the operator answered.
function verdictOf(answer: PermissionAnswer): Verdict {
  return 'deny' in answer ? { allow: false, message: `The operator denied this: ${answer.deny.trim()}` } : { allow: true };
}

// What closing a ticket says on it (ADR 0006): its work is on the task
// branch, not yet on the base branch, and at L1 only on the operator's machine.
function closingComment(task: Task, commits: string[]): string {
  const where = task.autonomy === 'L2' ? '' : ' Its commits are local to the operator’s machine until the task’s PR.';
  return (
    `Done on the task branch \`${task.worktree!.branch}\` by the agents factory’s task ${task.id} (${task.title}), ` +
    `in ${commits.map((commit) => commit.slice(0, 7)).join(', ')}.${where}`
  );
}

// What closing a research ticket says on it (ADR 0007): where the findings
// are, when the child committed any, and its report.
function researchComment(task: Task): string {
  const report = task.child!.report!;
  const where = report.commits.length
    ? `The findings are on \`${report.branch}\`: https://github.com/${task.repo}/tree/${report.branch}. It is never merged.`
    : 'It committed no findings.';
  return [`Researched by the agents factory’s task ${task.id} (${task.title}). ${where}`, report.summary, ...(report.notes ? [report.notes] : [])].join('\n\n');
}

// What reopening a cancelled task's ticket says on it (ADR 0006): the work
// that closed it never made it off the task branch.
function reopeningComment(task: Task): string {
  return (
    `Reopened: the agents factory’s task ${task.id} (${task.title}) was cancelled, so its work on the task branch ` +
    `\`${task.worktree!.branch}\` wasn’t merged.`
  );
}

// The repository's PR `number`, as `owner/name#n`.
function prRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

// What closing a cancelled root's draft PR says on it (ADR 0011).
function closingPrComment(task: Task): string {
  return `Closed: the agents factory’s task ${task.id} (${task.title}) was cancelled.`;
}

// What `spawn_child` tells the agent about the child it spawned.
function spawnedText(child: Task): string {
  const how = child.child?.awaited ? 'Your run waits for its report.' : 'It is fire-and-forget: its code never joins your branch, and list_children shows its report once it ends.';
  return `Spawned ${child.id} on ${child.worktree?.branch}. ${how}`;
}

// A child as `list_children` shows it to its parent's agent.
function childListing(child: Task) {
  return {
    id: child.id,
    title: child.title,
    state: label(child),
    progress: child.progress ?? null,
    branch: child.worktree?.branch ?? null,
    awaited: child.child?.awaited ?? false,
    report: child.child?.report ?? null,
    // The research ticket a research child resolves.
    research: child.child?.research?.ticket ?? null,
  };
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
