// The Lifecycle: repositories, tasks, runs and attention requests as a pure
// reducer with guards and selectors. Every operator command and every run event goes
// through `reduce`. Ported from the task-lifecycle prototype, amended by
// ADR 0003 (`interrupted`) and ADR 0008 (no usage-window stop, no budget).
// A launched task freezes its workflow preset, starts at one of its stages
// and advances across HITL boundaries on the operator's confirm; child tasks,
// handoffs, AFK boundaries and parking on a request's timeout arrive with
// their own slices.
import { DEFAULT_TIER, route, TIERS, type Tier } from '../models/routing.ts';
import { issueRef } from '../artifacts/capture.ts';
import { artifactKindsIn, fillOpening, type LaunchInputs, type ResolvedPreset, type Stage } from '../presets/presets.ts';

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

// What the agent asked through `AskUserQuestion`, shown as a card in the
// conversation, never as an attention request. `id` is the tool use's.
export type Question = {
  id: string;
  questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }[];
};
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

// The agent's proposal to advance the task to its next stage (`propose_advance`),
// shown until the operator confirms it or keeps talking instead.
export type Proposal = { reason: string };

// A root task's task branch and the worktree it is checked out in (ADR 0010).
export type TaskWorktree = { branch: string; path: string };

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
  tier: Tier;
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
  // name), and the tier the operator picked over every stage's, if any.
  inputs?: LaunchInputs & { issueKinds: string[]; tier: Tier | null };
  sessionId: string | null;
  runIds: string[];
  state: TaskState;
  createdAt: number;
  // Its place in the order tasks last became Queued in: first in, first out
  // goes by it. Tasks stored before it go first.
  queuePlace?: number;
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
  // Whose turn the conversation is on. A run starts on the agent's turn when
  // it has a first message to answer.
  turn: Turn;
  // The operator's messages sent during the agent's turn, delivered when it ends.
  queued: string[];
  // The card the agent's turn waits on, if any.
  question: Question | null;
  // The stage of its task's preset the run works on, if the task has one.
  stage: string | null;
  // The message the run starts with, or null to wait for the operator's.
  opening: string | null;
  proposal: Proposal | null;
  // The exact model: routed from the task's tier at start, then the one the
  // CLI reports it runs.
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
};

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
  | { type: 'handoff'; taskId: string; autonomy: AutonomyLevel }
  | { type: 'takeOver'; taskId: string }
  | { type: 'answer'; taskId: string }
  | { type: 'requestChanges'; taskId: string }
  | { type: 'markDone'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'setSlotCap'; cap: number }
  | { type: 'removeRepo'; repo: string };

// What the executor reports about a run.
export type RunEvent =
  | { type: 'runCompleted'; runId: string }
  | { type: 'runStarted'; runId: string; pid: number; createdAt: number; model: string }
  | { type: 'runFailed'; runId: string; reason: string }
  // The agent finished answering: the conversation is the operator's again.
  | { type: 'turnEnded'; runId: string }
  | { type: 'questionAsked'; runId: string; question: Question }
  | { type: 'attentionRaised'; runId: string; kind: 'question' | 'permission'; reason?: string }
  // The agent called `propose_advance`.
  | { type: 'advanceProposed'; runId: string; reason: string };

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
  tier: Tier;
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

// The daemon's clock found deadlines that have passed (ADR 0003).
export type ClockEvent = { type: 'deadlinesDue' };

export type LifecycleAction = OperatorCommand | RunEvent | RepoEvent | TaskLaunched | StageAdvanced | ClockEvent | ArtifactsSeen;

export type Reduction = { state: Lifecycle; refusal: string | null };

export const DEFAULT_SLOT_CAP = 2;
// The global default for an AFK run's max turns, under a stage's `max_turns`.
export const DEFAULT_MAX_TURNS = 300;
// What a resumed AFK run opens on: it takes no chat, so nothing else would
// start its turn.
const AFK_RESUME = 'Carry on, unattended, from where this conversation left off.';
export const PRIORITIES: readonly Priority[] = ['normal', 'urgent'];
// How long a HITL run may wait on the operator's turn before it is parked.
export const IDLE_PARK_MS = 30 * 60_000;

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

function stageOf(task: Task, id: string | null | undefined): Stage | undefined {
  return task.preset?.stages.find((stage) => stage.id === id);
}

// Why the stage's exit doesn't hold yet, or null. On a HITL boundary the
// operator's confirm ends the run completed, so `run-completed` holds.
function unmetExit(state: Lifecycle, task: Task, stage: Stage): string | null {
  if (stage.exit === undefined || stage.exit === 'run-completed') return null;
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
  const kind = variable.slice('artifacts.'.length);
  const issues = issuesOfKind(state, task, kind);
  if (issues.length) return issues.join(' ');
  return task.inputs?.issueKinds.includes(kind) && task.inputs.issues.length ? task.inputs.issues.join(' ') : null;
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
    }
  | { kind: 'ready'; taskId: string }
  | { kind: 'review'; taskId: string };

const attentionItem = ({ taskId, repo, id, kind, holdsRun, reason }: AttentionRequest): AttentionQueueItem => ({
  kind: 'attention',
  taskId,
  repo,
  requestId: id,
  attention: kind,
  holdsRun,
  reason,
});

// Everything waiting on the operator: requests about repositories first (they
// hold back every run in them), then the rest in task order.
export function attentionQueue(state: Lifecycle, watched: ReadonlySet<string> = new Set()): AttentionQueueItem[] {
  const items: AttentionQueueItem[] = [];
  for (const repository of Object.values(state.repositories)) {
    const request = openRepoRequest(state, repository.id);
    if (request) items.push(attentionItem(request));
  }
  for (const task of Object.values(state.tasks)) {
    const request = openRequest(state, task);
    if (task.state === 'waiting' && request) items.push(attentionItem(request));
    if (readyForYou(state, task, watched)) items.push({ kind: 'ready', taskId: task.id });
    if (task.state === 'in-review') items.push({ kind: 'review', taskId: task.id });
  }
  return items;
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
    if (run.status !== 'active') return `Run ${run.id} is not active.`;
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
      if (!TIERS.includes(action.tier)) return `${action.tier} is not a model tier (${TIERS.slice(0, -1).join(', ')} or ${TIERS.at(-1)}).`;
      if (action.maxTurns !== null && !(Number.isInteger(action.maxTurns) && action.maxTurns >= 1)) {
        return 'Max turns must be a whole number of at least 1.';
      }
      if (action.autonomy !== 'L1') return 'L2 runs in a sandbox, which the factory doesn’t have yet: launch at L1.';
      if (state.repositories[action.repo]!.missing) return `${action.repo} is missing, so its runs can’t start.`;
      return priorityRefusal(action.priority);
    case 'removeRepo': {
      const unfinished = unfinishedTasks(state, action.repo);
      return unfinished.length
        ? `${action.repo} has unfinished tasks (${unfinished.map((task) => task.id).join(', ')}). Finish or cancel them first.`
        : null;
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
    case 'handoff':
      return task.mode === 'HITL' && task.state === 'running'
        ? null
        : 'Only a task in a live HITL conversation can be handed off.';
    case 'takeOver':
      return task.mode === 'AFK' && ['queued', 'running', 'waiting'].includes(task.state)
        ? cantStartRuns(state, task)
        : 'Only a live AFK task (queued, running or needing you) can be taken over.';
    case 'answer':
      return task.state === 'waiting' && openRequest(state, task) ? null : `${task.id} has no open attention request.`;
    case 'requestChanges':
    case 'markDone':
      return task.state === 'in-review' ? null : `${task.id} is not in review.`;
    case 'cancel':
      return isTerminal(task) ? `${task.id} is already ${label(task)}.` : null;
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
    case 'stageAdvanced': {
      if (!task.preset || !task.stage) return `${task.id} follows no workflow preset.`;
      if (task.mode !== 'HITL' || (task.state !== 'running' && task.state !== 'queued')) {
        return `Only a HITL task in conversation or ready for you advances its stage (${task.id} is ${label(task)}).`;
      }
      const plan = planAdvance(state, task, action.skip);
      if ('refusal' in plan) return plan.refusal;
      return plan.to ? cantStartRuns(state, task) : null;
    }
    case 'attentionRaised':
      return task.mode === 'HITL' ? 'In a HITL run the agent asks in the conversation, not with an attention request.' : null;
    case 'repoRegistered': {
      const registered = state.repositories[action.repo];
      return registered ? `${action.repo} is already registered at ${registered.path}.` : null;
    }
    case 'repoMissing':
    case 'repoFound':
    case 'repoMoved':
    case 'deadlinesDue':
      return null;
  }
}

// An AFK run is steered only through attention requests and takeover.
function takesNoChat(task: Task): string {
  return `${task.id} is AFK, so it takes no chat. Take it over to talk to it.`;
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
// wait for the operator, unless they start a stage.
function startRun(
  state: Lifecycle,
  task: Task,
  at: number,
  { opening = task.runIds.length === 0 ? task.goal : task.mode === 'AFK' ? AFK_RESUME : null, resumesSession = task.runIds.length > 0 } = {},
): void {
  const run: Run = {
    id: nextId(state, 'run'),
    taskId: task.id,
    mode: task.mode,
    autonomy: task.mode === 'AFK' ? task.autonomy : null,
    status: 'active',
    outcome: null,
    interruption: null,
    resumesSession,
    turn: opening ? 'agent' : 'operator',
    queued: [],
    question: null,
    stage: task.stage ?? null,
    opening,
    proposal: null,
    model: route(task.tier).model,
    maxTurns: task.mode === 'AFK' ? (task.maxTurns ?? stageOf(task, task.stage)?.max_turns ?? DEFAULT_MAX_TURNS) : null,
    cli: null,
    parksAt: null,
    // Tasks stored before skill sets were frozen have none.
    skillSet: task.skillSet ?? null,
    startedAt: at,
    endedAt: null,
  };
  task.sessionId ??= `S${task.id.slice(1)}`;
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

// Ends a run that waited on the operator too long. Reopening the task starts
// a new run that resumes the session.
function park(task: Task, run: Run, at: number): void {
  endRun(run, 'parked', at);
  task.state = 'queued';
}

function raise(state: Lifecycle, task: Task, run: Run, kind: AttentionKind, holdsRun: boolean, reason: string | null, at: number): void {
  const request: AttentionRequest = {
    id: nextId(state, 'request'),
    repo: task.repo,
    taskId: task.id,
    runId: run.id,
    kind,
    status: 'open',
    holdsRun,
    reason,
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
    if (!cantStartRuns(state, task)) startRun(state, task, at);
  }
}

// The one admission check: whether another AFK run may start now. v1 checks
// only the slot cap; a usage-window gate would join it here (ADR 0008).
function admits(state: Lifecycle): boolean {
  return activeAfkRuns(state) < state.slotCap;
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
        tier: DEFAULT_TIER,
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
        tier: action.tier,
        worktree: { ...action.worktree },
        skillSet: action.skillSet,
        preset: structuredClone(action.preset),
        stage: action.stage,
        inputs: {
          prompt: action.prompt,
          issues: [...action.issues],
          issueKinds: artifactKindsIn(action.preset.stages.find(({ id }) => id === action.stage)!),
          tier: action.operatorTier,
        },
        sessionId: action.sessionId,
        runIds: [],
        state: 'queued',
        createdAt: at,
      };
      state.tasks[launched.id] = launched;
      if (mode === 'HITL') startRun(state, launched, at);
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
    case 'handoff':
      endRun(run!, 'handed off', at);
      task.mode = 'AFK';
      task.autonomy = action.autonomy;
      task.state = 'queued';
      break;
    case 'takeOver':
      if (request) request.status = 'superseded';
      if (run) endRun(run, 'taken over', at);
      task.mode = 'HITL';
      task.autonomy = null;
      startRun(state, task, at);
      break;
    case 'answer':
      request!.status = 'answered';
      if (request!.holdsRun) {
        // Resumes at once, even over the slot cap.
        run!.status = 'active';
        task.state = 'running';
      } else {
        task.state = 'queued';
      }
      break;
    case 'requestChanges':
      task.state = 'queued';
      break;
    case 'markDone':
      task.state = 'done';
      break;
    case 'cancel':
      if (run) endRun(run, 'cancelled', at);
      if (request) request.status = 'closed';
      task.state = 'cancelled';
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
      run!.proposal = { reason: action.reason };
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
        const placeholders = filled.missing.map((variable) => `{{${variable}}}`).join(' and ');
        const kinds = filled.missing.map((variable) => variable.replace(/^artifacts\./, '')).join(' or ');
        const reason = `${to.id} can’t start: its args need ${placeholders}, and ${task.id} has no ${kinds}.`;
        raise(state, task, state.runs[task.runIds.at(-1)!]!, 'stage-blocked', false, reason, at);
        break;
      }
      task.stage = to.id;
      // The operator's tier, then the stage's, then the task's so far.
      task.tier = task.inputs?.tier ?? to.model ?? task.tier;
      if (to.context === 'fresh') task.sessionId = action.sessionId;
      startRun(state, task, at, { opening: filled.opening, resumesSession: to.context !== 'fresh' });
      break;
    }
    case 'turnEnded':
      // A card the turn ended without is dropped. What waited is delivered
      // now, so the agent answers it at once.
      run!.question = null;
      if (run!.queued.length) run!.queued = [];
      else run!.turn = 'operator';
      break;
    case 'runCompleted':
      // With no stages yet, a task's run completing is its last stage.
      endRun(run!, 'completed', at);
      task.state = 'in-review';
      break;
    case 'runFailed':
      endRun(run!, 'failed', at);
      raise(state, task, run!, 'failure', false, action.reason, at);
      break;
    case 'attentionRaised':
      run!.status = 'suspended';
      raise(state, task, run!, action.kind, true, action.reason ?? null, at);
      break;
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
    case 'deadlinesDue':
      for (const overdue of overdueRuns(state, at)) park(state.tasks[overdue.taskId]!, overdue, at);
      break;
  }
}

export function reduce(state: Lifecycle, action: LifecycleAction, at: number): Reduction {
  const refusal = guard(state, action);
  if (refusal) return { state, refusal };
  const next = structuredClone(state);
  apply(next, action, at);
  placeInQueue(state, next);
  schedule(next, at);
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
