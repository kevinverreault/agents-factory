// The Lifecycle: repositories, tasks, runs and attention requests as a pure
// reducer with guards and selectors. Every operator command and every run event goes
// through `reduce`. Ported from the task-lifecycle prototype, amended by
// ADR 0003 (`interrupted`) and ADR 0008 (no usage-window stop, no budget).
// A launched task freezes its workflow preset, starts at one of its stages,
// advances across HITL boundaries on the operator's confirm and across AFK
// ones on its own, and works a loop stage's tickets one iteration at a time
// (ADR 0006); child tasks arrive with their own slice.
import { DEFAULT_TIER, isTier, route, TIERS, type Routes, type Tier } from '../models/routing.ts';
import { issueRef } from '../artifacts/capture.ts';
import type { Issue } from '../github/github.ts';
import { artifactKindsIn, fillOpening, type LaunchInputs, type ResolvedPreset, type Stage } from '../presets/presets.ts';
import { callWithRule, isRule, patternFor, ruleFor, uncovered, type ToolCall } from '../permissions/permissions.ts';

export type Mode = 'HITL' | 'AFK';
export type AutonomyLevel = 'L1' | 'L2';
// The operator's priority for an AFK task: urgent ones take a free slot first.
export type Priority = 'normal' | 'urgent';

export type TaskState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting' /* Needs you */
  | 'awaiting-children'
  | 'in-review'
  | 'done'
  | 'cancelled';
export type RunStatus = 'active' | 'suspended' | 'ended';
export type RunOutcome =
  | 'completed'
  | 'handed off'
  | 'taken over'
  | 'failed'
  | 'waiting on children'
  | 'parked'
  | 'cancelled'
  | 'interrupted';
export type Interruption = 'graceful' | 'unclean';
export type Turn = 'agent' | 'operator';

// What the agent asked through `AskUserQuestion`: in a HITL run a card in the
// conversation, in an AFK run a `question` attention request. `id` is the
// tool use's.
export type Question = {
  id: string;
  questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }[];
};
// The tool call a `permission` request asks about (ADR 0007): `id` is the
// tool use's, and `rule` the call's own, which Allow once allows. `proposed`
// holds what Allow for this task and Allow always propose for the parts no
// rule covers. Requests stored before it have none, and propose `rule`.
export type Permission = { id: string; tool: string; summary: string; rule: string; proposed?: ProposedRule[] };
// A pattern proposed for a part of a call no rule covers, with that part's
// summary. Parts that get the same pattern share one, under the first.
export type ProposedRule = { part: string; rule: string };
// How the operator answers a permission request: allow the call once; allow
// it, and the calls `rules` cover, for the rest of the task or always (see
// `RulesAnswer`); or deny it with a note the agent reads.
export type PermissionAnswer = { allow: 'once' } | RulesAnswer | { deny: string };
// An answer that allows by rules, the request's proposed ones if `rules` is
// absent: the task's for the rest of it, or, always, the operator's
// permissions file's, which the daemon adds them to, for every task.
export type RulesAnswer = { allow: 'task' | 'always'; rules?: string[] };
// Each question's text with its answer: an option's label (a multi-select's
// labels joined by ", "), or the operator's own words.
export type Answers = Record<string, string>;
export type AttentionKind =
  | 'question'
  | 'permission'
  | 'failure'
  | 'stage-blocked'
  | 'github-write'
  | 'pr-closed-unmerged'
  | 'repo-missing'
  | 'recovery-report';
export type AttentionStatus = 'open' | 'answered' | 'superseded' | 'closed';

// The agent's proposal to advance the task to its next stage
// (`propose_advance`) or hand it off (`propose_handoff`), shown until the
// operator acts on it or keeps talking instead.
export type Proposal = { kind: 'advance' | 'handoff'; reason: string };

// The handoff brief: what the HITL run agreed with the operator, which the
// AFK run starts from. `links` are issue refs, file paths or URLs.
export type Brief = { goal: string; decided: string[]; doneWhen: string[]; outOfScope: string[]; links: string[] };
// Whether a handoff's AFK run resumes the conversation or starts a fresh
// session from the brief alone.
export type ContinueAs = 'resume' | 'fresh';
export const CONTINUE_AS: readonly ContinueAs[] = ['resume', 'fresh'];
// How the task's worktree stands for a handoff: why it can't be confirmed
// yet, and the files the handoff commit takes.
export type Readiness = { blockers: string[]; toCommit: string[] };
// The handoff sheet, open on a HITL task from the operator's handoff until
// they confirm it or back out. Its fields are pre-filled from the AFK stage
// it hands off to; what the operator changes travels with the confirm.
export type HandoffSheet = {
  // The brief the HITL run wrote, or null while it hasn't yet.
  brief: Brief | null;
  // Whether a run was asked for the brief: an agent mid-turn is asked only
  // once its interrupted turn has ended.
  asked: boolean;
  // The AFK stage the handoff starts, or null when the task has none ahead.
  stage: string | null;
  continueAs: ContinueAs;
  autonomy: AutonomyLevel;
  tier: Tier;
  maxTurns: number;
  // The share of the context window the conversation fills, when known.
  contextShare: number | null;
  readiness: Readiness;
};
// How much of its model's context window a session fills, as its latest turn left it.
export type ContextUse = { used: number; window: number };

// A root task's task branch and the worktree it is checked out in (ADR 0010).
export type TaskWorktree = { branch: string; path: string };

// A task's Ralph loop at its loop stage (ADR 0006).
export type Loop = {
  // What the factory does before the next iteration: read the ticket set and
  // pick a ticket, or close the ticket the last iteration did. Null while an
  // iteration works on `ticket`.
  step: 'pick' | 'close' | null;
  ticket: string | null;
  // The task branch's tip when the iteration on `ticket` began, and the
  // commits it made since, once it succeeded.
  base: string | null;
  commits: string[];
};

// A Done root's cleanup while it hasn't finished (ADR 0011): why it last
// failed, if it did.
export type Cleanup = { problem: string | null };

// A ticket the task closed, with the commits that did its work.
export type ClosedTicket = { ref: string; commits: string[] };

// The label of the tickets a Ralph loop works.
export const READY_FOR_AGENT = 'ready-for-agent';

// The workflow preset a task froze at launch, with the commit of
// `origin/<base_branch>` its repo-scope presets were read from: editing a
// preset file later never changes it.
export type FrozenPreset = ResolvedPreset & { repoCommit: string };

export type Task = {
  id: string;
  title: string;
  // The repository the task works in, fixed at launch.
  repo: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  groups: string[];
  // Tasks stored before priorities are normal.
  priority?: Priority;
  // The operator's max turns for its AFK runs, over each stage's
  // `max_turns`; null when they set none.
  maxTurns?: number | null;
  // Its first run's first message: for a launched task, its start stage's
  // skill invoked on the launch inputs.
  goal: string | null;
  // The tier the operator picked, at launch or by re-tiering it, over every
  // stage's; null when they picked none.
  operatorTier?: Tier | null;
  // The task branch and its worktree, cut at launch.
  worktree: TaskWorktree | null;
  // The skill set version frozen at launch (ADR 0005): every run loads it.
  skillSet: string | null;
  // The preset frozen at launch, and the id of the stage the task is at.
  // Tasks created without a launch, or stored before presets, have none.
  preset?: FrozenPreset | null;
  stage?: string | null;
  // What it launched with: for later stages' args, the prompt and the issue
  // refs with the artifact kinds they stand for (those its start stage's args
  // name). Tasks stored before `operatorTier` keep the operator's launch
  // tier here.
  inputs?: LaunchInputs & { issueKinds: string[]; tier?: Tier | null };
  sessionId: string | null;
  // True while its next run starts the session `sessionId` names rather
  // than resuming it, as a fresh-context stage's first run does.
  newSession?: boolean;
  runIds: string[];
  state: TaskState;
  createdAt: number;
  // Its place in the order tasks last became Queued in: first in, first out
  // goes by it. Tasks stored before it go first.
  queuePlace?: number;
  // What its next AFK run opens on instead of carrying on, such as the
  // answers to a question its parked run asked.
  resumeWith?: string | null;
  // The rules the operator allowed for this task (ADR 0007): its L1 runs
  // make calls they cover without asking. Tasks stored before them have none.
  allowRules?: string[];
  // The rules the operator allowed once while its run was parked, which its
  // next run takes.
  allowOnce?: string[];
  // Its open handoff sheet, if any. Tasks stored before handoffs have none.
  handoff?: HandoffSheet | null;
  // How much of the context window its session fills, once a turn said.
  context?: ContextUse | null;
  // The handoff brief it was handed off with, if any.
  brief?: string | null;
  // Its Ralph loop while it is at a loop stage with a ticket set.
  loop?: Loop | null;
  // The tickets it closed: those ADR 0006's cancel cascade is to reopen.
  closedTickets?: ClosedTicket[];
  // True once the operator requested changes on it in review: past its last
  // stage, each of its runs that completes puts it back In review.
  changesRequested?: boolean;
  // While a Done root's cleanup (ADR 0011) hasn't finished: why it last
  // failed, if it did. It is tried again when the daemon next starts.
  cleanup?: Cleanup | null;
  // Where its session transcripts were archived once it ended: its
  // conversation is read from there.
  transcripts?: string | null;
};

export type Run = {
  id: string;
  taskId: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  status: RunStatus;
  outcome: RunOutcome | null;
  interruption: Interruption | null;
  resumesSession: boolean;
  // The session it works in. Runs stored before it have their task's.
  sessionId?: string;
  // Whose turn the conversation is on. A run starts on the agent's turn when
  // it has a first message to answer.
  turn: Turn;
  // The operator's messages sent during the agent's turn, delivered when it ends.
  queued: string[];
  // The card the agent's turn waits on, if any.
  question: Question | null;
  // The stage of its task's preset the run works on, if the task has one.
  stage: string | null;
  // The ticket it works on, as a Ralph loop's iteration. Runs stored before
  // loops have none.
  ticket?: string | null;
  // The message the run starts with, or null to wait for the operator's.
  opening: string | null;
  proposal: Proposal | null;
  // The tier it started at, and the exact model: routed from that tier at
  // start, then the one the CLI reports it runs. Runs stored before tiers
  // were recorded have only the model.
  tier?: Tier;
  model: string;
  // An AFK run's runaway guard (ADR 0008): hitting it fails the run. HITL
  // runs have none, and neither do runs stored before it.
  maxTurns?: number | null;
  // The CLI process the daemon spawned for the run, once it is up (ADR 0003).
  cli: { pid: number; createdAt: number } | null;
  // The skill set version the run loaded: its task's.
  skillSet: string | null;
  // While the run waits on the operator, when it parks if they still haven't
  // replied: a wall-clock deadline, persisted with the run (ADR 0003).
  parksAt: number | null;
  // The rules the operator allowed once for it: each lets one call with that
  // rule through. Runs stored before them have none.
  allowOnce?: string[];
  startedAt: number;
  endedAt: number | null;
};

export type AttentionRequest = {
  id: string;
  repo: string;
  // The task and run it is about, or null for a request about the repository
  // itself (`repo-missing`).
  taskId: string | null;
  runId: string | null;
  kind: AttentionKind;
  status: AttentionStatus;
  // True while the request keeps its run suspended; false once the run ended.
  holdsRun: boolean;
  reason: string | null;
  // What a `question` request asks. Requests stored before it have none.
  question?: Question | null;
  // The call a `permission` request asks about. Requests stored before it have none.
  permission?: Permission | null;
  raisedAt: number;
};

// A GitHub repository the operator registered through their own clone
// (ADR 0010). Its settings live only here, never in the repo.
export type Repository = {
  // `owner/name` on GitHub.
  id: string;
  path: string;
  baseBranch: string;
  defaultPreset: string;
  // True while the clone is no longer at `path`: its runs can't start.
  missing: boolean;
  registeredAt: number;
  // Whether the factory identity's App is installed on it, as last checked.
  // Repositories stored before the check have none until the daemon starts.
  app?: AppCheck;
  // Whether the skill set's per-repo setup is on its base branch, as last
  // checked. Repositories stored before the check have none until the daemon starts.
  skills?: SkillsSetup;
};

// Whether the factory identity's App is installed on a repository (ADR 0004),
// and when the daemon last asked GitHub. Where it isn't, `reason` says why
// and `fixUrl` opens the installation settings, unless the fix is elsewhere.
export type AppCheck = { installed: true; checkedAt: number } | { installed: false; checkedAt: number; reason: string; fixUrl: string | null };

// Whether the skill set's per-repo setup (ADR 0010) is on a repository's
// base branch on origin, and when the daemon last looked. Where it isn't,
// `reason` says what is missing, and the `setup` preset sets it up; or, when
// `failed`, why the daemon couldn't look.
export type SkillsSetup = { present: true; checkedAt: number } | { present: false; checkedAt: number; reason: string; failed: boolean };

// A file or GitHub issue a run produced, linked to its task. A file is the
// glossary or an ADR in the task's worktree, by its path there (with `/`);
// `committed` says whether the worktree has committed its latest change.
export type Artifact = { id: string; taskId: string; runId: string } & (
  | { kind: 'file'; path: string; committed: boolean }
  | { kind: 'issue'; url: string }
);

export type Lifecycle = {
  counters: { task: number; run: number; request: number; artifact: number; queue: number };
  repositories: Record<string, Repository>;
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  requests: Record<string, AttentionRequest>;
  artifacts: Record<string, Artifact>;
  slotCap: number;
};

// The operator's verbs.
export type OperatorCommand =
  | {
      type: 'createTask';
      title: string;
      repo: string;
      mode: Mode;
      autonomy?: AutonomyLevel;
      priority?: Priority;
      groups?: string[];
      submit?: boolean;
    }
  | { type: 'submit'; taskId: string }
  | { type: 'open'; taskId: string }
  | { type: 'sendMessage'; taskId: string; text: string }
  // Cuts the agent's turn short; the run lives on.
  | { type: 'interrupt'; taskId: string }
  | { type: 'answerQuestion'; taskId: string; questionId: string; answers: Answers }
  // Backs out of the handoff sheet: the conversation carries on.
  | { type: 'closeHandoff'; taskId: string }
  | { type: 'takeOver'; taskId: string }
  // Answers the task's open attention request: a question's with `answers`,
  // a permission request's with `permission`.
  | { type: 'answer'; taskId: string; answers?: Answers; permission?: PermissionAnswer }
  // Resumes the root's session on the operator's review comments.
  | { type: 'requestChanges'; taskId: string; comments: string }
  // Finishes a root In review. Unless `anyway`, the daemon first checks that
  // its task branch is merged into the base branch on origin.
  | { type: 'markDone'; taskId: string; anyway?: boolean }
  | { type: 'cancel'; taskId: string }
  // Sets the tier the task's next runs start at; a live run keeps its model.
  | { type: 'retier'; taskId: string; tier: Tier }
  // Sets an AFK task's autonomy level between runs, clamped by its stage's ceiling.
  | { type: 'setAutonomy'; taskId: string; autonomy: AutonomyLevel }
  | { type: 'setSlotCap'; cap: number }
  | { type: 'removeRepo'; repo: string };

// What the executor reports about a run.
export type RunEvent =
  // The daemon names a session, for a next AFK stage whose context is fresh.
  // A Ralph loop iteration's run carries the commits on the task branch
  // since its iteration began.
  | { type: 'runCompleted'; runId: string; sessionId?: string; commits?: string[] }
  | { type: 'runStarted'; runId: string; pid: number; createdAt: number; model: string }
  | { type: 'runFailed'; runId: string; reason: string }
  // The agent finished answering: the conversation is the operator's again.
  // `context` is how full the session is now, when the executor knows.
  | { type: 'turnEnded'; runId: string; context?: ContextUse }
  | { type: 'questionAsked'; runId: string; question: Question }
  // An AFK run asked the operator through `AskUserQuestion`.
  | { type: 'attentionRaised'; runId: string; kind: 'question'; question: Question }
  // An AFK run's tool call that neither the factory's allow list nor the
  // operator's rules cover (the daemon checks those): `parts` is the parts
  // of it they leave uncovered, the whole call if absent. `rulesProblem`
  // says why the operator's permissions file granted nothing, if it couldn't be read.
  | { type: 'permissionAsked'; runId: string; call: ToolCall; parts?: ToolCall[]; rulesProblem: string | null }
  // The agent called `propose_advance`.
  | { type: 'advanceProposed'; runId: string; reason: string }
  // The agent called `propose_handoff`.
  | { type: 'handoffProposed'; runId: string; reason: string }
  // The HITL run wrote the handoff brief the factory asked it for.
  | { type: 'briefWritten'; runId: string; brief: Brief };

// What artifact capture found after a tool call of the task's latest run,
// with whether each of the task's files (old and new) is committed. Hooks
// run in the background, so it may land after that run ended.
export type ArtifactsSeen = {
  type: 'artifactsSeen';
  taskId: string;
  files: { path: string; committed: boolean }[];
  issues: string[];
};

// What the daemon learns about the operator's clones.
export type RepoEvent =
  | { type: 'repoRegistered'; repo: string; path: string; baseBranch: string; defaultPreset: string }
  | { type: 'repoMissing'; repo: string; reason: string }
  | { type: 'repoFound'; repo: string }
  | { type: 'appChecked'; repo: string; check: AppCheck }
  | { type: 'skillsChecked'; repo: string; check: SkillsSetup }
  // `repo move`: the clone is at `path` now, and its task worktrees repaired.
  | { type: 'repoMoved'; repo: string; path: string };

// A task the daemon launched once its preset was frozen and its worktree cut.
// The daemon names the session, so the Claude session file can be found by it.
export type TaskLaunched = {
  type: 'taskLaunched';
  repo: string;
  title: string;
  // The launch inputs: those its start stage needs, at least.
  prompt: string;
  issues: string[];
  groups: string[];
  // The tier the operator picked on the launch card, if any.
  operatorTier: Tier | null;
  preset: FrozenPreset;
  // The start stage, and its first run's first message.
  stage: string;
  opening: string;
  // The handoff fields, which an AFK start stage's runs take.
  autonomy: AutonomyLevel;
  maxTurns: number | null;
  priority: Priority;
  worktree: TaskWorktree;
  sessionId: string;
  skillSet: string;
};

// The operator confirmed the advance sheet: the task leaves its stage for the
// next one it didn't skip (only optional stages can be). The daemon names a
// session, for a next stage whose context is fresh.
export type StageAdvanced = { type: 'stageAdvanced'; taskId: string; skip: string[]; sessionId: string };

// The operator opened the handoff sheet (`ctrl+h` or `/handoff`), and the
// daemon read how the task's worktree stands.
export type HandoffOpened = { type: 'handoffOpened'; taskId: string; readiness: Readiness };

// The daemon read the worktree again for the open handoff sheet, such as
// once the agent's turn ended: it may have changed files meanwhile.
export type ReadinessRead = { type: 'readinessRead'; taskId: string; readiness: Readiness };

// The brief and fields the operator confirms the handoff sheet with.
export type HandoffChoices = { brief: Brief; continueAs: ContinueAs; autonomy: AutonomyLevel; tier: Tier; maxTurns: number };

// The operator confirmed the handoff sheet, and the daemon committed the
// task's uncommitted files of `committed`. The daemon names a session, for
// continuing fresh.
export type HandedOff = { type: 'handedOff'; taskId: string; committed: string[]; sessionId: string } & HandoffChoices;

// What the daemon did to clean up after a Done root (ADR 0011): archived its
// transcripts to `transcripts`, then removed its worktree and local task
// branch, or failed to, saying why.
export type CleanupEvent = { type: 'cleanedUp'; taskId: string; transcripts: string } | { type: 'cleanupFailed'; taskId: string; reason: string };

// The daemon's clock found deadlines that have passed (ADR 0003).
export type ClockEvent = { type: 'deadlinesDue' };

// What the daemon did on GitHub between a Ralph loop's iterations (ADR 0006).
export type LoopEvent =
  // It read the ticket set, in order, with the task branch's tip, and names
  // a session for the iteration it may start, or for a fresh next stage.
  | { type: 'ticketsRead'; taskId: string; tickets: Issue[]; base: string; sessionId: string }
  | { type: 'ticketsUnread'; taskId: string; reason: string }
  // It closed the ticket an iteration did with its commits, or couldn't.
  | { type: 'ticketClosed'; taskId: string; ticket: string; commits: string[] }
  | { type: 'ticketUnclosed'; taskId: string; ticket: string; reason: string };

export type LifecycleAction =
  | OperatorCommand
  | RunEvent
  | RepoEvent
  | TaskLaunched
  | StageAdvanced
  | HandoffOpened
  | ReadinessRead
  | HandedOff
  | ClockEvent
  | LoopEvent
  | CleanupEvent
  | ArtifactsSeen;

export type Reduction = { state: Lifecycle; refusal: string | null };

export const DEFAULT_SLOT_CAP = 2;
// The global default for an AFK run's max turns, under a stage's `max_turns`.
export const DEFAULT_MAX_TURNS = 300;
// What a resumed AFK run opens on: it takes no chat, so nothing else would
// start its turn.
const AFK_RESUME = 'Carry on, unattended, from where this conversation left off.';
export const PRIORITIES: readonly Priority[] = ['normal', 'urgent'];
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['L1', 'L2'];
// Past this share of the context window, the handoff sheet pre-selects
// continuing fresh from the brief.
export const FRESH_AT = 0.6;
// What the factory asks a HITL run for when the operator opens the handoff sheet.
export const BRIEF_REQUEST =
  'The operator is handing this task off to an unattended AFK run. Write the handoff brief now with the factory’s ' +
  '`write_handoff_brief` tool: the goal, what you decided together, when the work is done, what is out of scope, and ' +
  'links to the issues and files that matter. Then end your turn: the operator reviews the brief before anything is handed off.';
// How long a HITL run may wait on the operator's turn before it is parked.
export const IDLE_PARK_MS = 30 * 60_000;
// How long an attention request may keep its run suspended before the run is parked.
export const REQUEST_PARK_MS = 60 * 60_000;

export function initialLifecycle(): Lifecycle {
  return {
    counters: { task: 0, run: 0, request: 0, artifact: 0, queue: 0 },
    repositories: {},
    tasks: {},
    runs: {},
    requests: {},
    artifacts: {},
    slotCap: DEFAULT_SLOT_CAP,
  };
}

// The id the next task created will get.
export function nextTaskId(state: Lifecycle): string {
  return `T${state.counters.task + 1}`;
}

// ---- Selectors ----

export function isTerminal(task: Task): boolean {
  return task.state === 'done' || task.state === 'cancelled';
}

// The repository's tasks that are neither Done nor Cancelled.
export function unfinishedTasks(state: Lifecycle, repo: string): Task[] {
  return Object.values(state.tasks).filter((task) => task.repo === repo && !isTerminal(task));
}

export function liveRun(state: Lifecycle, task: Task): Run | undefined {
  return task.runIds.map((id) => state.runs[id]!).find((run) => run.status !== 'ended');
}

export function openRequest(state: Lifecycle, task: Task): AttentionRequest | undefined {
  return Object.values(state.requests).find((request) => request.taskId === task.id && request.status === 'open');
}

// The open request about the repository itself, if any.
export function openRepoRequest(state: Lifecycle, repo: string): AttentionRequest | undefined {
  return Object.values(state.requests).find((request) => request.repo === repo && request.taskId === null && request.status === 'open');
}

// The registered repository the operator last launched a task in, if any.
export function lastUsedRepo(state: Lifecycle): string | null {
  return Object.values(state.tasks).findLast((task) => task.repo in state.repositories)?.repo ?? null;
}

export function artifactsOf(state: Lifecycle, task: Task): Artifact[] {
  return Object.values(state.artifacts).filter((artifact) => artifact.taskId === task.id);
}

// The task's issues of an artifact kind (`spec`…), as `owner/name#n`: those
// captured in a stage whose exit is `artifact:<kind>`, so an issue the grill
// merely printed is no spec.
export function issuesOfKind(state: Lifecycle, task: Task, kind: string): string[] {
  return artifactsOf(state, task).flatMap((artifact) => {
    if (artifact.kind !== 'issue') return [];
    const stage = stageOf(task, state.runs[artifact.runId]?.stage);
    if (stage?.exit !== `artifact:${kind}`) return [];
    return [issueRef(artifact.url)];
  });
}

// The task's issues of an artifact kind, else the launch issue refs that
// stand for that kind.
function issuesFor(state: Lifecycle, task: Task, kind: string): string[] {
  const issues = issuesOfKind(state, task, kind);
  if (issues.length) return issues;
  return task.inputs?.issueKinds.includes(kind) ? task.inputs.issues : [];
}

// The issues a Ralph loop reads its ticket set from (ADR 0006): the task's
// specs, whose sub-issues are its tickets and which never are one, else its
// tickets, each standing for its sub-issues if it has any. Null when the
// task has no ticket set, as after an early handoff that skipped the stages
// making them.
export type TicketSources = { kind: 'spec' | 'tickets'; refs: string[] };

export function ticketSources(state: Lifecycle, task: Task): TicketSources | null {
  const specs = issuesFor(state, task, 'spec');
  if (specs.length) return { kind: 'spec', refs: specs };
  const tickets = issuesFor(state, task, 'tickets');
  return tickets.length ? { kind: 'tickets', refs: tickets } : null;
}

// Every session the task's runs worked in, in order.
export function sessionsOf(state: Lifecycle, task: Task): string[] {
  const sessions = task.runIds.map((id) => state.runs[id]!.sessionId ?? task.sessionId);
  return [...new Set(sessions.filter((session) => session !== null))];
}

// The run the task last had, if any.
function lastRun(state: Lifecycle, task: Task): Run | undefined {
  return state.runs[task.runIds.at(-1)!];
}

// An AFK task between its loop's iterations, holding its slot while the
// factory reads or closes tickets.
export function betweenIterations(state: Lifecycle, task: Task): boolean {
  return task.mode === 'AFK' && task.state === 'running' && !!task.loop?.step && !liveRun(state, task);
}

// The tier the task's next run starts at: the operator's, then its stage's,
// then the global default.
export function nextTier(task: Task): Tier {
  return task.operatorTier ?? task.inputs?.tier ?? stageOf(task, task.stage)?.model ?? DEFAULT_TIER;
}

// The level an AFK stage's runs take: the asked one, held to its ceiling.
function clampAutonomy(level: AutonomyLevel, stage: Stage | undefined): AutonomyLevel {
  return stage?.autonomy === 'L1' ? 'L1' : level;
}

function stageOf(task: Task, id: string | null | undefined): Stage | undefined {
  return task.preset?.stages.find((stage) => stage.id === id);
}

// Why the stage's exit doesn't hold yet, or null. Its run ends completed
// on either boundary (on a HITL one by the operator's confirm), so
// `run-completed` holds.
function unmetExit(state: Lifecycle, task: Task, stage: Stage): string | null {
  if (stage.exit === undefined || stage.exit === 'run-completed') return null;
  // A loop with no ticket set runs once, and its run completing ends it.
  if (stage.exit === 'tickets-closed' && !ticketSources(state, task)) return null;
  const kind = /^artifact:(.*)$/.exec(stage.exit)?.[1];
  const why =
    kind === undefined
      ? `the factory can’t tell yet whether ${stage.exit} holds`
      : issuesOfKind(state, task, kind).length === 0
        ? `${task.id} has no ${kind} yet`
        : null;
  return why && `${stage.id}’s exit, ${stage.exit}, doesn’t hold: ${why}.`;
}

// A template variable of a stage's args, filled from what the task has: its
// launch prompt, or its issues of an artifact kind, else the launch issue
// refs that stand for that kind. Null when it has none.
function argValue(state: Lifecycle, task: Task, variable: string): string | null {
  if (variable === 'prompt') return task.inputs?.prompt.trim() || null;
  return issuesFor(state, task, variable.slice('artifacts.'.length)).join(' ') || null;
}

// Why a stage can't start: the args variables the task has no value for.
function cantFill(task: Task, stage: Stage, missing: string[]): string {
  const placeholders = missing.map((variable) => `{{${variable}}}`).join(' and ');
  const kinds = missing.map((variable) => variable.replace(/^artifacts\./, '')).join(' or ');
  return `${stage.id} can’t start: its args need ${placeholders}, and ${task.id} has no ${kinds}.`;
}

// Moves the task to the stage: the next run of a fresh-context one starts
// the session the daemon named, `sessionId`, instead of resuming.
function enterStage(task: Task, stage: Stage, sessionId: string | undefined): void {
  task.stage = stage.id;
  if (stage.context !== 'fresh' || !sessionId) return;
  task.sessionId = sessionId;
  task.newSession = true;
}

// Starts the task's Ralph loop at a loop stage, if it has a ticket set: the
// factory picks the first iteration's ticket once the task has a slot.
function enterLoop(state: Lifecycle, task: Task, stage: Stage): boolean {
  if (stage.kind !== 'loop' || !ticketSources(state, task)) return false;
  task.loop = picking();
  return true;
}

// A loop about to pick its next ticket.
function picking(): Loop {
  return { step: 'pick', ticket: null, base: null, commits: [] };
}

// Moves the task on from the AFK stage whose exit holds: to the next AFK
// stage, queued for a slot, or In review past the last. What stops it
// raises a stage-blocked request about `run`.
function advanceFrom(state: Lifecycle, task: Task, from: Stage, run: Run | undefined, sessionId: string | undefined, at: number): void {
  const blocked = (reason: string) => raise(state, task, run, 'stage-blocked', false, reason, at);
  task.loop = null;
  // Past the last stage, the root task is the operator's to review.
  const to = nextAfkStage(task, from);
  if (!to) {
    task.state = 'in-review';
    return;
  }
  if (to.mode === 'HITL') return blocked(`The next stage, ${to.id}, is HITL: take ${task.id} over to start it.`);
  if (to.kind === 'action') return blocked(`The next stage, ${to.id}, is a factory action, which the factory can’t run yet.`);
  const filled = fillOpening(to, (variable) => argValue(state, task, variable));
  if ('missing' in filled) return blocked(cantFill(task, to, filled.missing));
  // Queued as work continuing something in flight, for the scheduler.
  enterStage(task, to, sessionId);
  if (!enterLoop(state, task, to)) task.resumeWith = filled.opening;
  task.state = 'queued';
}

// What a Ralph loop's iteration on `ticket` opens on (ADR 0006): its stage's
// skill on the ticket alone, and the factory context its fresh session
// starts from. `tickets` is the ticket set as just read.
function iterationOpening(state: Lifecycle, task: Task, stage: Stage, ticket: string, tickets: Issue[]): string {
  const specs = issuesFor(state, task, 'spec');
  const done = task.closedTickets ?? [];
  const facts = [
    ...(specs.length ? [`- Spec: ${specs.join(', ')}`] : []),
    `- Progress: ${tickets.filter(({ open }) => !open).length} of ${tickets.length} tickets closed.`,
    ...(done.length ? ['- Done by this task:', ...done.map(({ ref, commits }) => `  - ${ref}: ${commits.map(short).join(', ')}`)] : []),
  ];
  const context = [
    '## Factory context',
    `This run is one iteration of the factory’s Ralph loop on ${task.id}, ${task.title}. Work on ${ticket} alone, commit its work ` +
      `onto the task branch ${task.worktree?.branch} and leave the tree clean. The factory closes the ticket once it judges ` +
      'the iteration: don’t close it yourself, and don’t start another ticket.',
    facts.join('\n'),
    ...(task.brief ? [task.brief] : []),
  ];
  return `/factory:${stage.skill} ${ticket}\n\n${context.join('\n\n')}`;
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

// The stage an AFK stage leads to, or null past the last: a stage that
// requires L2 (such as open-pr) is skipped below it.
function nextAfkStage(task: Task, from: Stage): Stage | null {
  const { stages } = task.preset!;
  return stages.slice(stages.indexOf(from) + 1).find((stage) => stage.requires !== 'L2' || task.autonomy === 'L2') ?? null;
}

// Where the advance sheet's confirm takes the task: past its stage and the
// optional ones it skips, to the next HITL stage, or past the last stage
// (null). An AFK stage next is the handoff's to start.
function planAdvance(state: Lifecycle, task: Task, skip: string[]): { from: Stage; to: Stage | null } | { refusal: string } {
  const { stages } = task.preset!;
  const at = stages.findIndex(({ id }) => id === task.stage);
  let next = at + 1;
  for (; next < stages.length && skip.includes(stages[next]!.id); next++) {
    if (!stages[next]!.optional) return { refusal: `${stages[next]!.id} isn’t optional, so it can’t be skipped.` };
  }
  const from = stages[at]!;
  const to = stages[next] ?? null;
  const between = stages.slice(at + 1, next).map(({ id }) => id);
  const stray = skip.find((id) => !between.includes(id));
  if (stray) return { refusal: `${stray} isn’t a stage between ${from.id} and ${to?.id ?? 'the end'}.` };
  const unmet = unmetExit(state, task, from);
  if (unmet) return { refusal: unmet };
  if (to?.mode === 'AFK') return { refusal: `The next stage, ${to.id}, is AFK: hand ${task.id} off to start it.` };
  return { from, to };
}

// The live runs whose park deadline has passed at `at`.
export function overdueRuns(state: Lifecycle, at: number): Run[] {
  return Object.values(state.runs).filter((run) => run.status !== 'ended' && run.parksAt !== null && run.parksAt <= at);
}

export function activeAfkRuns(state: Lifecycle): number {
  return Object.values(state.runs).filter((run) => run.status === 'active' && run.mode === 'AFK').length;
}

// Whether a live run waits on the operator: its turn, or a card it asked.
export function waitsOnOperator(run: Run): boolean {
  return run.status === 'active' && (run.turn === 'operator' || run.question !== null);
}

// A HITL task whose turn is the operator's: queued for its conversation, or
// in one that waits on them while no TUI has it open (`watched` holds the
// runs whose conversations are open).
export function readyForYou(state: Lifecycle, task: Task, watched: ReadonlySet<string>): boolean {
  if (task.mode !== 'HITL') return false;
  if (task.state === 'queued') return true;
  const run = task.state === 'running' ? liveRun(state, task) : undefined;
  return !!run && waitsOnOperator(run) && !watched.has(run.id);
}

// `ready` is what `readyForYou` says of the task.
export function label(task: Task, ready = false): string {
  switch (task.state) {
    case 'draft':
      return 'Draft';
    case 'queued':
      return task.mode === 'HITL' ? 'Ready for you' : 'Queued';
    case 'running':
      if (task.mode === 'AFK') return 'Running';
      return ready ? 'Ready for you' : 'In conversation';
    case 'waiting':
      return 'Needs you';
    case 'awaiting-children':
      return 'Waiting on children';
    case 'in-review':
      return 'In review';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
  }
}

export type AttentionQueueItem =
  | {
      kind: 'attention';
      taskId: string | null;
      repo: string;
      requestId: string;
      attention: AttentionKind;
      holdsRun: boolean;
      reason: string | null;
      question: Question | null;
      permission: Permission | null;
    }
  | { kind: 'ready'; taskId: string }
  | { kind: 'review'; taskId: string };

const attentionItem = ({ taskId, repo, id, kind, holdsRun, reason, question = null, permission = null }: AttentionRequest): AttentionQueueItem => ({
  kind: 'attention',
  taskId,
  repo,
  requestId: id,
  attention: kind,
  holdsRun,
  reason,
  question,
  permission,
});

// Everything waiting on the operator, the most urgent first: failures, then
// the other requests (those about repositories included), each oldest first,
// then HITL tasks ready for the operator, then root tasks in review.
export function attentionQueue(state: Lifecycle, watched: ReadonlySet<string> = new Set()): AttentionQueueItem[] {
  const requests: AttentionRequest[] = [];
  const ready: AttentionQueueItem[] = [];
  const reviews: AttentionQueueItem[] = [];
  for (const repository of Object.values(state.repositories)) {
    const request = openRepoRequest(state, repository.id);
    if (request) requests.push(request);
  }
  for (const task of Object.values(state.tasks)) {
    const request = openRequest(state, task);
    if (task.state === 'waiting' && request) requests.push(request);
    if (readyForYou(state, task, watched)) ready.push({ kind: 'ready', taskId: task.id });
    if (task.state === 'in-review') reviews.push({ kind: 'review', taskId: task.id });
  }
  const failure = (request: AttentionRequest) => Number(request.kind === 'failure');
  requests.sort((a, b) => failure(b) - failure(a) || a.raisedAt - b.raisedAt);
  return [...requests.map(attentionItem), ...ready, ...reviews];
}

// ---- Reducer ----

function taskOf(state: Lifecycle, action: LifecycleAction): Task | undefined {
  if ('taskId' in action) return state.tasks[action.taskId];
  if ('runId' in action) {
    const run = state.runs[action.runId];
    return run && state.tasks[run.taskId];
  }
  return undefined;
}

// Why an action is illegal right now, or null.
export function guard(state: Lifecycle, action: LifecycleAction): string | null {
  if ('taskId' in action && !state.tasks[action.taskId]) return `There is no task ${action.taskId}.`;
  if ('runId' in action) {
    const run = state.runs[action.runId];
    if (!run) return `There is no run ${action.runId}.`;
    if (run.status === 'suspended' && action.type === 'permissionAsked') {
      // The task's rules still decide a suspended run's other calls.
      if (!grantFor(state.tasks[run.taskId]!, run, action)) return 'Another request of this run is waiting on the operator.';
    } else if (run.status !== 'active' && !(run.status === 'suspended' && action.type === 'runFailed')) {
      // A suspended run can still fail: its CLI may exit while it waits on the operator.
      return `Run ${run.id} is not active.`;
    }
  }
  if ('repo' in action && action.type !== 'repoRegistered' && !state.repositories[action.repo]) {
    return `${action.repo} is not registered.`;
  }
  const task = taskOf(state, action)!;
  switch (action.type) {
    case 'createTask':
      if (!action.title.trim()) return 'A task needs a title.';
      return action.priority === undefined ? null : priorityRefusal(action.priority);
    case 'taskLaunched':
      // Which launch inputs it needs is its start stage's to say.
      if (action.operatorTier !== null && !isTier(action.operatorTier)) return tierRefusal(action.operatorTier);
      if (action.maxTurns !== null && !(Number.isInteger(action.maxTurns) && action.maxTurns >= 1)) {
        return 'Max turns must be a whole number of at least 1.';
      }
      if (action.autonomy !== 'L1') return 'L2 runs in a sandbox, which the factory doesn’t have yet: launch at L1.';
      if (state.repositories[action.repo]!.missing) return `${action.repo} is missing, so its runs can’t start.`;
      return priorityRefusal(action.priority);
    case 'removeRepo': {
      const unfinished = unfinishedTasks(state, action.repo);
      if (unfinished.length) return `${action.repo} has unfinished tasks (${unfinished.map((task) => task.id).join(', ')}). Finish or cancel them first.`;
      const cleaning = Object.values(state.tasks).filter((task) => task.repo === action.repo && task.cleanup);
      return cleaning.length ? `The factory is still cleaning up after ${cleaning.map((task) => task.id).join(', ')} in ${action.repo}.` : null;
    }
    case 'submit':
      return task.state === 'draft' ? null : 'Only a draft can be submitted.';
    case 'open':
      if (task.mode !== 'HITL') return `${task.id} is AFK. Take it over to talk to it.`;
      if (task.state !== 'draft' && task.state !== 'queued') return `${task.id} isn't ready for a conversation (it is ${label(task)}).`;
      return cantStartRuns(state, task);
    case 'sendMessage':
      if (task.mode === 'AFK') return takesNoChat(task);
      if (!action.text.trim()) return 'A message needs text.';
      if (task.handoff) return sheetOpen(task);
      return liveRun(state, task)?.status === 'active' ? null : `${task.id} has no live conversation.`;
    case 'interrupt': {
      if (task.mode === 'AFK') return takesNoChat(task);
      const run = liveRun(state, task);
      if (run?.status !== 'active') return `${task.id} has no live conversation.`;
      return run.turn === 'agent' ? null : `${task.id}’s agent isn’t mid-turn.`;
    }
    case 'answerQuestion': {
      const { question } = liveRun(state, task) ?? {};
      if (question?.id !== action.questionId) return 'That question is no longer open.';
      const answered = question.questions.every(({ question }) => action.answers[question]?.trim());
      return answered ? null : 'Answer every question on the card.';
    }
    case 'readinessRead':
      return task.handoff ? null : `${task.id} has no handoff sheet open.`;
    case 'handedOff': {
      if (!task.handoff) return `${task.id} has no handoff sheet open.`;
      if (!task.handoff.brief) return 'The agent hasn’t written the brief yet: you confirm the brief you have read.';
      if (!tidyBrief(action.brief).goal) return 'The brief needs a goal.';
      if (!CONTINUE_AS.includes(action.continueAs)) return 'Continue as resume, or fresh from the brief.';
      if (!AUTONOMY_LEVELS.includes(action.autonomy)) return `${action.autonomy} is not an autonomy level (${AUTONOMY_LEVELS.join(' or ')}).`;
      if (action.autonomy !== 'L1') return 'L2 runs in a sandbox, which the factory doesn’t have yet: hand off at L1.';
      if (!isTier(action.tier)) return tierRefusal(action.tier);
      return Number.isInteger(action.maxTurns) && action.maxTurns >= 1 ? null : 'Max turns must be a whole number of at least 1.';
    }
    case 'closeHandoff':
      return task.handoff ? null : `${task.id} has no handoff sheet open.`;
    case 'takeOver':
      return task.mode === 'AFK' && ['queued', 'running', 'waiting'].includes(task.state)
        ? cantStartRuns(state, task)
        : 'Only a live AFK task (queued, running or needing you) can be taken over.';
    case 'answer': {
      const request = task.state === 'waiting' ? openRequest(state, task) : undefined;
      if (!request) return `${task.id} has no open attention request.`;
      if (request.permission && !validPermissionAnswer(action.permission)) {
        return 'Allow it once, for this task or always, or deny it with a note for the agent.';
      }
      if (allowsByRules(action.permission)) {
        const { allow, rules } = action.permission;
        if (rules !== undefined && !(Array.isArray(rules) && rules.length > 0 && rules.every(isRule))) {
          return `${BY_RULES[allow].answer} needs at least one rule, each such as \`Bash(sed -i *)\`.`;
        }
        // Requests stored before they named their call have no rule to add.
        if (allow === 'always' && !request.permission) return 'This request doesn’t name its call: allow it once or for this task.';
      }
      const answered = request.question?.questions.every(({ question }) => action.answers?.[question]?.trim()) ?? true;
      return answered ? null : 'Answer every question on the card.';
    }
    case 'requestChanges':
      if (task.state !== 'in-review') return `${task.id} is not in review.`;
      return typeof action.comments === 'string' && action.comments.trim() ? null : 'Request changes needs your review comments: say what to change.';
    case 'markDone':
      return task.state === 'in-review' ? null : `${task.id} is not in review.`;
    case 'cancel':
      return isTerminal(task) ? `${task.id} is already ${label(task)}.` : null;
    case 'retier':
      if (!isTier(action.tier)) return tierRefusal(action.tier);
      return isTerminal(task) ? `${task.id} is already ${label(task)}.` : null;
    case 'setAutonomy': {
      if (!AUTONOMY_LEVELS.includes(action.autonomy)) return `${action.autonomy} is not an autonomy level (${AUTONOMY_LEVELS.join(' or ')}).`;
      if (task.mode !== 'AFK') return `${task.id} is HITL, so it has no autonomy level.`;
      if (isTerminal(task)) return `${task.id} is already ${label(task)}.`;
      // A run's containment never shifts under it.
      const run = liveRun(state, task);
      if (run) return `${task.id}’s autonomy level changes only between runs, and its run ${run.id} is live.`;
      return clampAutonomy(action.autonomy, stageOf(task, task.stage)) === 'L2'
        ? 'L2 runs in a sandbox, which the factory doesn’t have yet: stay at L1.'
        : null;
    }
    case 'setSlotCap':
      return Number.isInteger(action.cap) && action.cap >= 1 ? null : 'The slot cap must be a whole number of at least 1.';
    case 'runStarted':
    case 'runCompleted':
    case 'runFailed':
    case 'turnEnded':
      return null;
    case 'artifactsSeen':
      return isTerminal(task) ? `${task.id} is already ${label(task)}.` : null;
    case 'questionAsked':
      return task.mode === 'HITL' ? null : 'In an AFK run a question is an attention request.';
    case 'advanceProposed':
      return task.mode === 'HITL' ? null : 'Only a HITL run proposes advancing; AFK stages advance on their own.';
    case 'handoffProposed':
    case 'briefWritten':
      return task.mode === 'HITL' ? null : `${task.id} is AFK already.`;
    case 'handoffOpened': {
      if (task.mode !== 'HITL' || (task.state !== 'running' && task.state !== 'queued')) {
        return `Only a HITL task in conversation or ready for you can be handed off (${task.id} is ${label(task)}).`;
      }
      if (task.runIds.length === 0) return `There is nothing to hand off yet: ${task.id} has had no conversation.`;
      const to = handoffStage(task);
      if (to?.kind === 'action') return `The next AFK stage, ${to.id}, is a factory action, which the factory can’t run yet.`;
      return liveRun(state, task) ? null : cantStartRuns(state, task);
    }
    case 'stageAdvanced': {
      if (!task.preset || !task.stage) return `${task.id} follows no workflow preset.`;
      if (task.handoff) return sheetOpen(task);
      if (task.mode !== 'HITL' || (task.state !== 'running' && task.state !== 'queued')) {
        return `Only a HITL task in conversation or ready for you advances its stage (${task.id} is ${label(task)}).`;
      }
      const plan = planAdvance(state, task, action.skip);
      if ('refusal' in plan) return plan.refusal;
      return plan.to ? cantStartRuns(state, task) : null;
    }
    case 'attentionRaised':
    case 'permissionAsked':
      return task.mode === 'HITL' ? 'In a HITL run the agent asks in the conversation, not with an attention request.' : null;
    case 'repoRegistered': {
      const registered = state.repositories[action.repo];
      return registered ? `${action.repo} is already registered at ${registered.path}.` : null;
    }
    case 'repoMissing':
    case 'repoFound':
    case 'repoMoved':
    case 'appChecked':
    case 'skillsChecked':
    case 'deadlinesDue':
      return null;
    case 'ticketsRead':
      if (!betweenIterations(state, task) || task.loop!.step !== 'pick') return `${task.id} isn’t picking a ticket.`;
      // Refused while the clone is missing: the pick runs again once it is found.
      return cantStartRuns(state, task);
    case 'ticketsUnread':
      return betweenIterations(state, task) && task.loop!.step === 'pick' ? null : `${task.id} isn’t picking a ticket.`;
    case 'ticketUnclosed':
      return betweenIterations(state, task) && task.loop!.step === 'close' && task.loop!.ticket === action.ticket
        ? null
        : `${task.id} isn’t closing ${action.ticket}.`;
    case 'ticketClosed':
      // A ticket closed is the task's however it stands now, even cancelled.
      return null;
    case 'cleanedUp':
    case 'cleanupFailed':
      return task.cleanup ? null : `${task.id} has no cleanup under way.`;
  }
}

// Allow once, for the task or always, or deny with a note that isn't blank.
function validPermissionAnswer(answer: PermissionAnswer | undefined): boolean {
  if (!answer) return false;
  return 'deny' in answer ? typeof answer.deny === 'string' && answer.deny.trim() !== '' : answer.allow === 'once' || allowsByRules(answer);
}

// Whether the answer allows by rules: for the rest of the task, or always.
export function allowsByRules(answer: PermissionAnswer | undefined): answer is RulesAnswer {
  return !!answer && 'allow' in answer && (answer.allow === 'task' || answer.allow === 'always');
}

// Each answer by rules: what the operator chose, and how long its rules hold.
const BY_RULES = {
  task: { answer: 'Allow for this task', holds: 'for the rest of this task' },
  always: { answer: 'Allow always', holds: 'from now on, in every task,' },
} as const;

// The open permission requests whose calls the rules, with their task's own,
// now cover: those an Allow always whose rules these are lets through.
export function coveredRequests(state: Lifecycle, rules: readonly string[]): AttentionRequest[] {
  return Object.values(state.requests).filter((request) => {
    if (request.status !== 'open' || !request.permission || !request.taskId) return false;
    const { id, summary, rule } = request.permission;
    const taskRules = state.tasks[request.taskId]!.allowRules ?? [];
    return uncovered([...rules, ...taskRules], { id, summary, ...callWithRule(rule) }).length === 0;
  });
}

// Which of the operator's answers lets the call through, if any: the task's
// rules, when they cover every part the factory's and operator's rules left
// uncovered, or the call's own rule allowed once for the run.
function grantFor(task: Task, run: Run, asked: PermissionAsked): 'task' | 'once' | null {
  const rule = ruleFor(asked.call);
  // Rules stored before patterns were each a whole call's own.
  if (task.allowRules?.includes(rule) || leftUncovered(task, asked).length === 0) return 'task';
  return run.allowOnce?.includes(rule) ? 'once' : null;
}

// A run's call the factory's and operator's rules left parts of uncovered.
type PermissionAsked = Extract<RunEvent, { type: 'permissionAsked' }>;

// The parts of the call no rule covers, the task's included.
function leftUncovered(task: Task, { call, parts = [call] }: PermissionAsked): ToolCall[] {
  return parts.flatMap((part) => uncovered(task.allowRules ?? [], part));
}

// What a permission request proposes for the parts left uncovered: a pattern
// for each, once.
function proposals(parts: ToolCall[]): ProposedRule[] {
  // Each pattern, with the summary of the first part it was proposed for.
  const proposed = new Map<string, string>();
  for (const part of parts) {
    const rule = patternFor(part);
    if (!proposed.has(rule)) proposed.set(rule, part.summary);
  }
  return [...proposed].map(([rule, summary]) => ({ part: summary, rule }));
}

// The conversation waits while the handoff sheet is open over it.
function sheetOpen(task: Task): string {
  return `The handoff sheet is open on ${task.id}: back out of it (esc) to keep talking.`;
}

// The AFK stage a handoff starts: the first from the task's own stage on.
// Remaining HITL stages are skipped, and so is a stage that requires L2,
// which a handoff doesn't reach yet. Null when the task has none ahead.
function handoffStage(task: Task): Stage | null {
  const stages = task.preset?.stages ?? [];
  const from = Math.max(stages.findIndex(({ id }) => id === task.stage), 0);
  return stages.slice(from).find((stage) => stage.mode === 'AFK' && stage.requires !== 'L2') ?? null;
}

// A new handoff sheet, pre-filled from the AFK stage it hands off to. L2
// runs in a sandbox, which the factory doesn't have yet, so it hands off at L1.
function newHandoffSheet(task: Task, readiness: Readiness): HandoffSheet {
  const stage = handoffStage(task);
  const share = task.context ? task.context.used / task.context.window : null;
  return {
    brief: null,
    asked: false,
    stage: stage?.id ?? null,
    continueAs: share !== null && share > FRESH_AT ? 'fresh' : 'resume',
    autonomy: 'L1',
    tier: task.operatorTier ?? task.inputs?.tier ?? stage?.model ?? DEFAULT_TIER,
    maxTurns: task.maxTurns ?? stage?.max_turns ?? DEFAULT_MAX_TURNS,
    contextShare: share,
    readiness,
  };
}

// The brief with its text trimmed and its empty items dropped: it comes from
// the agent's tool call, or the operator's edits.
function tidyBrief(brief: Brief): Brief {
  const items = (list: unknown) => (Array.isArray(list) ? list.map((item) => String(item).trim()).filter(Boolean) : []);
  return {
    goal: String(brief.goal ?? '').trim(),
    decided: items(brief.decided),
    doneWhen: items(brief.doneWhen),
    outOfScope: items(brief.outOfScope),
    links: items(brief.links),
  };
}

// The brief as the AFK run reads it, its empty sections left out.
export function briefText({ goal, decided, doneWhen, outOfScope, links }: Brief): string {
  const sections: [string, string[]][] = [
    ['Decided', decided],
    ['Done when', doneWhen],
    ['Out of scope', outOfScope],
    ['Links', links],
  ];
  const listed = sections.filter(([, items]) => items.length).map(([heading, items]) => `## ${heading}\n\n${items.map((item) => `- ${item}`).join('\n')}`);
  return ['# Handoff brief', goal, ...listed].join('\n\n');
}

// An AFK run is steered only through attention requests and takeover.
function takesNoChat(task: Task): string {
  return `${task.id} is AFK, so it takes no chat. Take it over to talk to it.`;
}

function tierRefusal(tier: string): string {
  return `${tier} is not a model tier (${TIERS.slice(0, -1).join(', ')} or ${TIERS.at(-1)}).`;
}

function priorityRefusal(priority: Priority): string | null {
  return PRIORITIES.includes(priority) ? null : `${priority} is not a priority (${PRIORITIES.join(' or ')}).`;
}

// Why no new run can start in the task's repository, or null (ADR 0010).
function cantStartRuns(state: Lifecycle, task: Task): string | null {
  return state.repositories[task.repo]?.missing ? `${task.repo} is missing, so its runs can’t start.` : null;
}

function nextId(state: Lifecycle, kind: Exclude<keyof Lifecycle['counters'], 'queue'>): string {
  const prefix = { task: 'T', run: 'R', request: 'A', artifact: 'X' }[kind];
  return prefix + ++state.counters[kind];
}

// A task's first run starts on its goal; later ones resume its session and
// wait for the operator, unless they start a stage. A later AFK run carries
// on, or opens on what the task saved for it.
function startRun(
  state: Lifecycle,
  task: Task,
  at: number,
  {
    opening = task.runIds.length === 0 ? task.goal : (task.resumeWith ?? (task.mode === 'AFK' ? AFK_RESUME : null)),
    resumesSession = task.runIds.length > 0 && !task.newSession,
  } = {},
): void {
  task.resumeWith = null;
  task.newSession = false;
  const tier = nextTier(task);
  const allowOnce = task.allowOnce ?? [];
  task.allowOnce = [];
  task.sessionId ??= `S${task.id.slice(1)}`;
  const run: Run = {
    id: nextId(state, 'run'),
    taskId: task.id,
    mode: task.mode,
    autonomy: task.mode === 'AFK' ? clampAutonomy(task.autonomy!, stageOf(task, task.stage)) : null,
    status: 'active',
    outcome: null,
    interruption: null,
    resumesSession,
    sessionId: task.sessionId,
    turn: opening ? 'agent' : 'operator',
    queued: [],
    question: null,
    stage: task.stage ?? null,
    ticket: task.mode === 'AFK' ? (task.loop?.ticket ?? null) : null,
    opening,
    proposal: null,
    tier,
    // Routed by `reduce`, once it knows every run the action starts.
    model: '',
    maxTurns: task.mode === 'AFK' ? (task.maxTurns ?? stageOf(task, task.stage)?.max_turns ?? DEFAULT_MAX_TURNS) : null,
    cli: null,
    parksAt: null,
    allowOnce,
    // Tasks stored before skill sets were frozen have none.
    skillSet: task.skillSet ?? null,
    startedAt: at,
    endedAt: null,
  };
  state.runs[run.id] = run;
  task.runIds.push(run.id);
  task.state = 'running';
}

function endRun(run: Run, outcome: RunOutcome, at: number): void {
  run.status = 'ended';
  run.outcome = outcome;
  run.parksAt = null;
  run.endedAt = at;
}

// Ends a run that waited on the operator too long. Reopening the task, or
// answering the request its run was suspended on, starts a new run that
// resumes the session.
function park(state: Lifecycle, task: Task, run: Run, at: number): void {
  endRun(run, 'parked', at);
  const request = openRequest(state, task);
  if (request?.holdsRun) request.holdsRun = false;
  else task.state = 'queued';
}

// What the run that resumes a root on the operator's review comments opens on.
function changesOpening(task: Task, comments: string): string {
  const asked = `The operator reviewed ${task.id} and requested changes:\n\n${comments.trim()}`;
  // A HITL run's operator is there to say more.
  if (task.mode === 'HITL') return asked;
  return `${asked}\n\nMake them, unattended, and commit them to the task branch: the task goes back to the operator’s review once your run ends.`;
}

// What a question's answers are, for the run that resumes after its asker parked.
function openingWithAnswers(question: Question, answers: Answers): string {
  const lines = question.questions.map(({ question }) => `${question} ${answers[question]!.trim()}`);
  return `While this conversation was parked, the operator answered your question:\n\n${lines.join('\n')}\n\n${AFK_RESUME}`;
}

// The run waits on an attention request, holding no slot, until it parks.
function suspend(run: Run, at: number): void {
  run.status = 'suspended';
  run.parksAt = at + REQUEST_PARK_MS;
}

// What the operator answered a permission request with, for the run that
// resumes after its asker parked.
function openingWithVerdict(permission: Permission, answer: PermissionAnswer): string {
  const { tool, summary } = permission;
  const verdict =
    'deny' in answer
      ? `denied ${tool}: ${summary}. Their note: ${answer.deny.trim()}`
      : answer.allow === 'once'
        ? `allowed ${tool} once: ${summary}. Make that call again now.`
        : `allowed ${tool}: ${summary}, and ${BY_RULES[answer.allow].holds} the calls these rules cover: ${allowedRules(permission, answer).join(', ')}.`;
  return `While this conversation was parked, the operator ${verdict}

${AFK_RESUME}`;
}

// The rules an answer by rules allows: the operator's, or else the ones the
// request proposed.
export function allowedRules(permission: Permission, answer: RulesAnswer): string[] {
  return answer.rules?.map((rule) => rule.trim()) ?? permission.proposed?.map(({ rule }) => rule) ?? [permission.rule];
}

function raise(
  state: Lifecycle,
  task: Task,
  // The run it is about, if the task has had one.
  run: Run | undefined,
  kind: AttentionKind,
  holdsRun: boolean,
  reason: string | null,
  at: number,
  { question = null, permission = null }: { question?: Question | null; permission?: Permission | null } = {},
): void {
  const request: AttentionRequest = {
    id: nextId(state, 'request'),
    repo: task.repo,
    taskId: task.id,
    runId: run?.id ?? null,
    kind,
    status: 'open',
    holdsRun,
    reason,
    question,
    permission,
    raisedAt: at,
  };
  state.requests[request.id] = request;
  task.state = 'waiting';
}

function addArtifact(state: Lifecycle, artifact: DistributiveOmit<Artifact, 'id'>): void {
  const id = nextId(state, 'artifact');
  state.artifacts[id] = { id, ...artifact } as Artifact;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function closeRepoRequest(state: Lifecycle, repo: string): void {
  const request = openRepoRequest(state, repo);
  if (request) request.status = 'closed';
}

// The scheduler (ADR 0008): starts queued AFK tasks in turn while the
// admission check lets them. Urgent tasks go first, then work that continues
// something in flight (a task that has run before), then first in, first out.
function schedule(state: Lifecycle, at: number): void {
  const urgent = (task: Task) => Number(task.priority === 'urgent');
  const continuing = (task: Task) => Number(task.runIds.length > 0);
  const queued = Object.values(state.tasks).filter((task) => task.state === 'queued' && task.mode === 'AFK');
  queued.sort((a, b) => urgent(b) - urgent(a) || continuing(b) - continuing(a) || (a.queuePlace ?? 0) - (b.queuePlace ?? 0));
  for (const task of queued) {
    if (!admits(state)) return;
    if (cantStartRuns(state, task)) continue;
    // A loop takes its slot for the factory's step before its next iteration.
    if (task.loop?.step) task.state = 'running';
    else startRun(state, task, at);
  }
}

// The slots taken: by active AFK runs, and by loops between iterations.
export function heldSlots(state: Lifecycle): number {
  return activeAfkRuns(state) + Object.values(state.tasks).filter((task) => betweenIterations(state, task)).length;
}

// The one admission check: whether another AFK run may start now. v1 checks
// only the slot cap; a usage-window gate would join it here (ADR 0008).
function admits(state: Lifecycle): boolean {
  return heldSlots(state) < state.slotCap;
}

function apply(state: Lifecycle, action: LifecycleAction, at: number): void {
  const task = taskOf(state, action)!;
  const run = task && liveRun(state, task);
  const request = task && openRequest(state, task);
  switch (action.type) {
    case 'createTask': {
      const created: Task = {
        id: nextId(state, 'task'),
        title: action.title.trim(),
        repo: action.repo,
        mode: action.mode,
        autonomy: action.mode === 'AFK' ? (action.autonomy ?? 'L1') : null,
        groups: [...(action.groups ?? [])],
        priority: action.priority ?? 'normal',
        goal: null,
        operatorTier: null,
        worktree: null,
        skillSet: null,
        sessionId: null,
        runIds: [],
        state: action.submit ? 'queued' : 'draft',
        createdAt: at,
      };
      state.tasks[created.id] = created;
      break;
    }
    case 'taskLaunched': {
      // The task takes its start stage's mode: a HITL stage opens its
      // conversation at once, and an AFK one queues for a slot with its
      // handoff fields.
      const { mode } = action.preset.stages.find(({ id }) => id === action.stage)!;
      const launched: Task = {
        id: nextId(state, 'task'),
        title: action.title,
        repo: action.repo,
        mode,
        autonomy: mode === 'AFK' ? action.autonomy : null,
        priority: action.priority,
        maxTurns: mode === 'AFK' ? action.maxTurns : null,
        groups: [...new Set(action.groups.map((group) => group.trim()).filter(Boolean))],
        goal: action.opening,
        operatorTier: action.operatorTier,
        worktree: { ...action.worktree },
        skillSet: action.skillSet,
        preset: structuredClone(action.preset),
        stage: action.stage,
        inputs: {
          prompt: action.prompt,
          issues: [...action.issues],
          issueKinds: artifactKindsIn(action.preset.stages.find(({ id }) => id === action.stage)!),
        },
        sessionId: action.sessionId,
        runIds: [],
        state: 'queued',
        createdAt: at,
      };
      state.tasks[launched.id] = launched;
      if (mode === 'HITL') startRun(state, launched, at);
      else enterLoop(state, launched, stageOf(launched, action.stage)!);
      break;
    }
    case 'submit':
      task.state = 'queued';
      break;
    case 'open':
      startRun(state, task, at);
      break;
    case 'sendMessage':
      // Talking on sets the agent's proposal aside.
      run!.proposal = null;
      // The executor delivers it at once on the operator's turn; mid-turn it waits.
      if (run!.turn === 'agent') run!.queued.push(action.text);
      else run!.turn = 'agent';
      break;
    case 'interrupt':
      // The executor cuts the turn, and reports its end like any other.
      break;
    case 'answerQuestion':
      // The executor hands the answers to the waiting turn.
      run!.question = null;
      break;
    case 'handedOff': {
      const sheet = task.handoff!;
      if (run) endRun(run, 'handed off', at);
      task.handoff = null;
      task.mode = 'AFK';
      task.autonomy = action.autonomy;
      // What the operator changed on the sheet holds for every later stage too.
      if (action.tier !== sheet.tier) task.operatorTier = action.tier;
      if (action.maxTurns !== sheet.maxTurns) task.maxTurns = action.maxTurns;
      // The brief is the task's goal of record, and the AFK run's first
      // message, after its stage's skill: the brief stands in for args an
      // early handoff skipped the stages for.
      task.goal = briefText(tidyBrief(action.brief));
      task.brief = task.goal;
      const to = stageOf(task, sheet.stage);
      if (to) task.stage = to.id;
      // A loop with a ticket set starts from its tickets; one without runs
      // once from the brief.
      task.loop = null;
      const loops = !!to && enterLoop(state, task, to);
      const opening = to && fillOpening(to, (variable) => argValue(state, task, variable) ?? '');
      if (!loops) task.resumeWith = opening && 'opening' in opening && opening.opening ? `${opening.opening}\n\n${task.goal}` : task.goal;
      if (action.continueAs === 'fresh') {
        task.sessionId = action.sessionId;
        task.newSession = true;
        task.context = null;
      }
      for (const artifact of artifactsOf(state, task)) {
        if (artifact.kind === 'file' && action.committed.includes(artifact.path)) artifact.committed = true;
      }
      // Queued as work continuing something in flight, for the scheduler.
      task.state = 'queued';
      break;
    }
    case 'closeHandoff':
      task.handoff = null;
      break;
    case 'takeOver':
      if (request) request.status = 'superseded';
      if (run) endRun(run, 'taken over', at);
      task.mode = 'HITL';
      task.autonomy = null;
      // The operator works the ticket now: handing back off picks afresh.
      task.loop = null;
      // What an AFK run was to open on is the operator's to say now.
      task.resumeWith = null;
      // A fresh session no run has started yet gives way to the one the
      // last run used: the operator steps into the conversation they saw.
      const lastSession = lastRun(state, task)?.sessionId;
      if (task.newSession && lastSession) {
        task.sessionId = lastSession;
        task.newSession = false;
      }
      startRun(state, task, at);
      break;
    case 'answer':
      request!.status = 'answered';
      // Allow always's rules are the operator's file's, which the daemon added them to.
      if (request!.permission && allowsByRules(action.permission) && action.permission.allow === 'task') {
        const rules = (task.allowRules ??= []);
        for (const rule of allowedRules(request!.permission, action.permission)) if (!rules.includes(rule)) rules.push(rule);
      }
      if (request!.holdsRun) {
        // Resumes at once, even over the slot cap.
        run!.status = 'active';
        run!.parksAt = null;
        task.state = 'running';
      } else {
        if (request!.question) task.resumeWith = openingWithAnswers(request!.question, action.answers!);
        if (request!.permission) {
          const answer = action.permission!;
          if ('allow' in answer && answer.allow === 'once') (task.allowOnce ??= []).push(request!.permission.rule);
          task.resumeWith = openingWithVerdict(request!.permission, answer);
        }
        // An AFK stage that couldn't move on carries on, told why.
        if (request!.kind === 'stage-blocked' && task.mode === 'AFK' && !task.loop?.step) {
          task.resumeWith = `The factory couldn’t move this task on: ${request!.reason}\n\n${AFK_RESUME}`;
        }
        task.state = 'queued';
      }
      break;
    case 'requestChanges':
      task.changesRequested = true;
      task.resumeWith = changesOpening(task, action.comments);
      task.state = 'queued';
      break;
    case 'markDone':
      task.state = 'done';
      // The daemon archives its transcripts, then removes its worktree and branch.
      if (task.worktree) task.cleanup = { problem: null };
      break;
    case 'cleanedUp':
      task.cleanup = null;
      task.transcripts = action.transcripts;
      break;
    case 'cleanupFailed':
      task.cleanup = { problem: action.reason };
      break;
    case 'cancel':
      if (run) endRun(run, 'cancelled', at);
      if (request) request.status = 'closed';
      task.handoff = null;
      task.state = 'cancelled';
      break;
    case 'retier':
      task.operatorTier = action.tier;
      break;
    case 'setAutonomy':
      task.autonomy = clampAutonomy(action.autonomy, stageOf(task, task.stage));
      break;
    case 'setSlotCap':
      state.slotCap = action.cap;
      break;
    case 'runStarted':
      run!.cli = { pid: action.pid, createdAt: action.createdAt };
      run!.model = action.model;
      break;
    case 'questionAsked':
      run!.question = action.question;
      break;
    case 'advanceProposed':
      run!.proposal = { kind: 'advance', reason: action.reason };
      break;
    case 'handoffProposed':
      run!.proposal = { kind: 'handoff', reason: action.reason };
      break;
    case 'handoffOpened': {
      const sheet = (task.handoff ??= newHandoffSheet(task, action.readiness));
      sheet.readiness = action.readiness;
      if (sheet.brief) break;
      if (!run) {
        // A parked conversation is resumed just to write the brief.
        startRun(state, task, at, { opening: BRIEF_REQUEST });
        sheet.asked = true;
        break;
      }
      run.proposal = null;
      if (run.turn === 'operator') {
        // The executor asks at once, or again when the agent's turn ended without writing it.
        run.turn = 'agent';
        sheet.asked = true;
      } else if (!sheet.asked) {
        // The executor interrupts the turn: what it waited on goes with it.
        run.queued = [];
        run.question = null;
      }
      break;
    }
    case 'readinessRead':
      task.handoff!.readiness = action.readiness;
      break;
    case 'briefWritten':
      // A brief written after the operator backed out stays in the conversation only.
      if (task.handoff && !task.handoff.brief) task.handoff.brief = tidyBrief(action.brief);
      break;
    case 'stageAdvanced': {
      const plan = planAdvance(state, task, action.skip);
      if ('refusal' in plan) break;
      const { to } = plan;
      if (run) endRun(run, 'completed', at);
      // Past the last stage, the root task is the operator's to review.
      if (!to) {
        task.state = 'in-review';
        break;
      }
      const filled = fillOpening(to, (variable) => argValue(state, task, variable));
      if ('missing' in filled) {
        // The stage raises an attention request instead of starting. The
        // task stays at the stage it was leaving, to advance again from.
        raise(state, task, lastRun(state, task), 'stage-blocked', false, cantFill(task, to, filled.missing), at);
        break;
      }
      enterStage(task, to, action.sessionId);
      startRun(state, task, at, { opening: filled.opening });
      break;
    }
    case 'turnEnded':
      if (action.context) task.context = { ...action.context };
      // A card the turn ended without is dropped. What waited is delivered
      // now, so the agent answers it at once: the brief, once a handoff
      // interrupted the turn.
      run!.question = null;
      if (task.handoff && !task.handoff.asked && !task.handoff.brief) task.handoff.asked = true;
      else if (run!.queued.length) run!.queued = [];
      else run!.turn = 'operator';
      break;
    case 'runCompleted': {
      endRun(run!, 'completed', at);
      // A run of an AFK stage moves the task on by itself. Any other (a task
      // with no preset, or one handed off with no AFK stage ahead) is its last.
      const from = stageOf(task, run!.stage);
      if (from?.mode !== 'AFK' || task.changesRequested) {
        task.state = 'in-review';
        break;
      }
      if (run!.ticket) {
        // The factory judges the iteration (ADR 0006): its run completed and
        // committed, on a tree its git guards found clean. Its ticket closes
        // next, the task holding its slot.
        if (action.commits?.length) task.loop = { ...task.loop!, step: 'close', commits: [...action.commits] };
        else raise(state, task, run, 'failure', false, `The iteration on ${run!.ticket} made no new commit on ${task.worktree?.branch}, so the ticket stays open.`, at);
        break;
      }
      const unmet = unmetExit(state, task, from);
      if (unmet) raise(state, task, run, 'stage-blocked', false, unmet, at);
      else advanceFrom(state, task, from, run, action.sessionId, at);
      break;
    }
    case 'runFailed':
      // The request a suspended run waited on can't resume it any more.
      if (request?.holdsRun) request.status = 'superseded';
      endRun(run!, 'failed', at);
      raise(state, task, run!, 'failure', false, action.reason, at);
      break;
    case 'attentionRaised': {
      suspend(run!, at);
      // Named by what it asks.
      const reason = action.question.questions.map(({ question }) => question).join(' ');
      raise(state, task, run!, 'question', true, reason, at, { question: action.question });
      break;
    }
    case 'permissionAsked': {
      // The executor lets a call the operator allowed through, using up a
      // rule allowed once.
      const grant = grantFor(task, run!, action);
      if (grant === 'once') run!.allowOnce!.splice(run!.allowOnce!.indexOf(ruleFor(action.call)), 1);
      if (grant) break;
      const { id, tool, summary } = action.call;
      suspend(run!, at);
      // Named by the parts no rule covers.
      const parts = leftUncovered(task, action);
      const problem = action.rulesProblem && ` (${action.rulesProblem.replace(/\.$/, '')}, so its rules granted nothing.)`;
      const permission = { id, tool, summary, rule: ruleFor(action.call), proposed: proposals(parts) };
      raise(state, task, run!, 'permission', true, `${tool}: ${parts.map((part) => part.summary).join(' · ')}${problem ?? ''}`, at, { permission });
      break;
    }
    case 'artifactsSeen': {
      // One artifact per file or issue of a task, however often it is seen.
      const existing = (test: (artifact: Artifact) => boolean) => artifactsOf(state, task).find(test);
      const runId = task.runIds.at(-1)!;
      for (const { path, committed } of action.files) {
        const file = existing((artifact) => artifact.kind === 'file' && artifact.path === path);
        if (file?.kind === 'file') file.committed = committed;
        else addArtifact(state, { taskId: task.id, runId, kind: 'file', path, committed });
      }
      for (const url of action.issues) {
        if (!existing((artifact) => artifact.kind === 'issue' && artifact.url === url)) {
          addArtifact(state, { taskId: task.id, runId, kind: 'issue', url });
        }
      }
      break;
    }
    case 'removeRepo':
      closeRepoRequest(state, action.repo);
      delete state.repositories[action.repo];
      break;
    case 'repoRegistered':
      state.repositories[action.repo] = {
        id: action.repo,
        path: action.path,
        baseBranch: action.baseBranch,
        defaultPreset: action.defaultPreset,
        missing: false,
        registeredAt: at,
      };
      break;
    case 'repoMissing': {
      state.repositories[action.repo]!.missing = true;
      // One request per repository, however many runs it holds back.
      if (openRepoRequest(state, action.repo)) break;
      const request: AttentionRequest = {
        id: nextId(state, 'request'),
        repo: action.repo,
        taskId: null,
        runId: null,
        kind: 'repo-missing',
        status: 'open',
        holdsRun: false,
        reason: action.reason,
        raisedAt: at,
      };
      state.requests[request.id] = request;
      break;
    }
    case 'repoMoved':
      state.repositories[action.repo]!.path = action.path;
    // falls through: the clone is in place at its new path.
    case 'repoFound':
      state.repositories[action.repo]!.missing = false;
      closeRepoRequest(state, action.repo);
      break;
    case 'appChecked':
      state.repositories[action.repo]!.app = action.check;
      break;
    case 'skillsChecked':
      state.repositories[action.repo]!.skills = action.check;
      break;
    case 'deadlinesDue':
      for (const overdue of overdueRuns(state, at)) park(state, state.tasks[overdue.taskId]!, overdue, at);
      break;
    case 'ticketsRead': {
      const stage = stageOf(task, task.stage)!;
      const last = lastRun(state, task);
      const tickets = action.tickets.filter(({ labels }) => labels.includes(READY_FOR_AGENT));
      const open = tickets.filter((ticket) => ticket.open);
      if (open.length === 0) {
        // Every ticket is closed: tickets-closed holds.
        if (tickets.length || task.closedTickets?.length) advanceFrom(state, task, stage, last, action.sessionId, at);
        else raise(state, task, last, 'stage-blocked', false, `${stage.id} has no tickets: ${ticketSources(state, task)!.refs.join(', ')} hold no open issue labelled ${READY_FOR_AGENT}.`, at);
        break;
      }
      // The frontier: the open tickets with no open blockers, first in sub-issue order.
      const next = open.find((ticket) => ticket.openBlockers.length === 0);
      if (!next) {
        const blocked = open.map(({ ref, openBlockers }) => `${ref} by ${openBlockers.join(', ')}`).join('; ');
        raise(state, task, last, 'stage-blocked', false, `${stage.id}’s loop stalled: every open ticket is blocked (${blocked}).`, at);
        break;
      }
      // Each iteration is a fresh session.
      task.loop = { step: null, ticket: next.ref, base: action.base, commits: [] };
      task.sessionId = action.sessionId;
      task.newSession = true;
      task.context = null;
      startRun(state, task, at, { opening: iterationOpening(state, task, stage, next.ref, tickets) });
      break;
    }
    case 'ticketsUnread':
      raise(state, task, lastRun(state, task), 'failure', false, `The factory couldn’t read ${task.id}’s tickets from GitHub: ${action.reason}`, at);
      break;
    case 'ticketClosed':
      (task.closedTickets ??= []).push({ ref: action.ticket, commits: [...action.commits] });
      if (task.loop?.step === 'close' && task.loop.ticket === action.ticket) task.loop = picking();
      break;
    case 'ticketUnclosed':
      // Retried once the operator answers, and never as the operator (ADR 0004).
      raise(
        state,
        task,
        lastRun(state, task),
        'github-write',
        false,
        `The factory couldn’t close ${action.ticket} on GitHub as its App: ${action.reason} Fix it, then answer to try again.`,
        at,
      );
      break;
  }
}

// `routes` is the routing table each run the action starts is routed
// through (ADR 0009). While it can't be read, queued AFK tasks wait, and an
// action that would start a run itself is refused.
export function reduce(state: Lifecycle, action: LifecycleAction, at: number, routes: Routes): Reduction {
  const refusal = guard(state, action);
  if (refusal) return { state, refusal };
  const next = structuredClone(state);
  apply(next, action, at);
  placeInQueue(state, next);
  if (!('unreadable' in routes)) schedule(next, at);
  const started = Object.values(next.runs).filter((run) => !state.runs[run.id]);
  if (started.length) {
    if ('unreadable' in routes) return { state, refusal: routes.unreadable };
    for (const run of started) run.model = route(routes, run.tier!).model;
  }
  armIdleParks(next, at);
  return { state: next, refusal: null };
}

// Gives each task that has just become Queued the next place in the queue.
function placeInQueue(before: Lifecycle, after: Lifecycle): void {
  for (const task of Object.values(after.tasks)) {
    if (task.state === 'queued' && before.tasks[task.id]?.state !== 'queued') task.queuePlace = ++after.counters.queue;
  }
}

// A HITL run's idle clock (ADR 0003): its park deadline is set when the run
// starts waiting on the operator, and cleared once it no longer does.
function armIdleParks(state: Lifecycle, at: number): void {
  for (const run of Object.values(state.runs)) {
    if (run.mode !== 'HITL') continue;
    if (waitsOnOperator(run)) run.parksAt ??= at + IDLE_PARK_MS;
    else run.parksAt = null;
  }
}
