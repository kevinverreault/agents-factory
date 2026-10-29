// The Lifecycle: repositories, tasks, runs and attention requests as a pure
// reducer with guards and selectors. Every operator command and every run event goes
// through `reduce`. Ported from the task-lifecycle prototype, amended by
// ADR 0003 (`interrupted`) and ADR 0008 (no usage-window stop, no budget).
// Child tasks, stages and parking arrive with their own slices.
import { DEFAULT_TIER, route, type Tier } from '../models/routing.ts';

export type Mode = 'HITL' | 'AFK';
export type AutonomyLevel = 'L1' | 'L2';

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

// A root task's task branch and the worktree it is checked out in (ADR 0010).
export type TaskWorktree = { branch: string; path: string };

export type Task = {
  id: string;
  title: string;
  // The repository the task works in, fixed at launch.
  repo: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  groups: string[];
  // What the operator launched the task with: its first run's first message.
  goal: string | null;
  tier: Tier;
  // The task branch and its worktree, cut at launch.
  worktree: TaskWorktree | null;
  sessionId: string | null;
  runIds: string[];
  state: TaskState;
  createdAt: number;
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
  // The exact model: routed from the task's tier at start, then the one the
  // CLI reports it runs.
  model: string;
  // The CLI process the daemon spawned for the run, once it is up (ADR 0003).
  cli: { pid: number; createdAt: number } | null;
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

export type Lifecycle = {
  counters: { task: number; run: number; request: number };
  repositories: Record<string, Repository>;
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  requests: Record<string, AttentionRequest>;
  slotCap: number;
};

// The operator's verbs.
export type OperatorCommand =
  | { type: 'createTask'; title: string; repo: string; mode: Mode; autonomy?: AutonomyLevel; groups?: string[]; submit?: boolean }
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
  | { type: 'attentionRaised'; runId: string; kind: 'question' | 'permission'; reason?: string };

// What the daemon learns about the operator's clones.
export type RepoEvent =
  | { type: 'repoRegistered'; repo: string; path: string; baseBranch: string; defaultPreset: string }
  | { type: 'repoMissing'; repo: string; reason: string }
  | { type: 'repoFound'; repo: string };

// A task the daemon launched once its worktree was cut. The daemon names the
// session, so the Claude session file can be found by it.
export type TaskLaunched = {
  type: 'taskLaunched';
  repo: string;
  title: string;
  prompt: string;
  worktree: TaskWorktree;
  sessionId: string;
};

export type LifecycleAction = OperatorCommand | RunEvent | RepoEvent | TaskLaunched;

export type Reduction = { state: Lifecycle; refusal: string | null };

export const DEFAULT_SLOT_CAP = 2;

export function initialLifecycle(): Lifecycle {
  return {
    counters: { task: 0, run: 0, request: 0 },
    repositories: {},
    tasks: {},
    runs: {},
    requests: {},
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
      return action.title.trim() ? null : 'A task needs a title.';
    case 'taskLaunched':
      if (!action.prompt.trim()) return 'A task needs a prompt.';
      return state.repositories[action.repo]!.missing ? `${action.repo} is missing, so its runs can’t start.` : null;
    case 'removeRepo': {
      const unfinished = Object.values(state.tasks).filter((task) => task.repo === action.repo && !isTerminal(task));
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
      if (!action.text.trim()) return 'A message needs text.';
      return task.mode === 'HITL' && liveRun(state, task)?.status === 'active' ? null : `${task.id} has no live conversation.`;
    case 'interrupt': {
      const run = task.mode === 'HITL' ? liveRun(state, task) : undefined;
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
    case 'questionAsked':
      return task.mode === 'HITL' ? null : 'In an AFK run a question is an attention request.';
    case 'attentionRaised':
      return task.mode === 'HITL' ? 'In a HITL run the agent asks in the conversation, not with an attention request.' : null;
    case 'repoRegistered': {
      const registered = state.repositories[action.repo];
      return registered ? `${action.repo} is already registered at ${registered.path}.` : null;
    }
    case 'repoMissing':
    case 'repoFound':
      return null;
  }
}

// Why no new run can start in the task's repository, or null (ADR 0010).
function cantStartRuns(state: Lifecycle, task: Task): string | null {
  return state.repositories[task.repo]?.missing ? `${task.repo} is missing, so its runs can’t start.` : null;
}

function nextId(state: Lifecycle, kind: keyof Lifecycle['counters']): string {
  const prefix = { task: 'T', run: 'R', request: 'A' }[kind];
  return prefix + ++state.counters[kind];
}

function startRun(state: Lifecycle, task: Task, at: number): void {
  const run: Run = {
    id: nextId(state, 'run'),
    taskId: task.id,
    mode: task.mode,
    autonomy: task.mode === 'AFK' ? task.autonomy : null,
    status: 'active',
    outcome: null,
    interruption: null,
    resumesSession: task.runIds.length > 0,
    turn: task.runIds.length === 0 && task.goal ? 'agent' : 'operator',
    queued: [],
    question: null,
    model: route(task.tier).model,
    cli: null,
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
  run.endedAt = at;
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

function closeRepoRequest(state: Lifecycle, repo: string): void {
  const request = openRepoRequest(state, repo);
  if (request) request.status = 'closed';
}

// Starts queued AFK tasks, first in first out, while a slot is free.
function schedule(state: Lifecycle, at: number): void {
  for (const task of Object.values(state.tasks)) {
    if (activeAfkRuns(state) >= state.slotCap) return;
    if (task.state === 'queued' && task.mode === 'AFK' && !cantStartRuns(state, task)) startRun(state, task, at);
  }
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
        goal: null,
        tier: DEFAULT_TIER,
        worktree: null,
        sessionId: null,
        runIds: [],
        state: action.submit ? 'queued' : 'draft',
        createdAt: at,
      };
      state.tasks[created.id] = created;
      break;
    }
    case 'taskLaunched': {
      // One HITL stage: the conversation opens at once.
      const launched: Task = {
        id: nextId(state, 'task'),
        title: action.title,
        repo: action.repo,
        mode: 'HITL',
        autonomy: null,
        groups: [],
        goal: action.prompt,
        tier: DEFAULT_TIER,
        worktree: { ...action.worktree },
        sessionId: action.sessionId,
        runIds: [],
        state: 'queued',
        createdAt: at,
      };
      state.tasks[launched.id] = launched;
      startRun(state, launched, at);
      break;
    }
    case 'submit':
      task.state = 'queued';
      break;
    case 'open':
      startRun(state, task, at);
      break;
    case 'sendMessage':
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
    case 'repoFound':
      state.repositories[action.repo]!.missing = false;
      closeRepoRequest(state, action.repo);
      break;
  }
}

export function reduce(state: Lifecycle, action: LifecycleAction, at: number): Reduction {
  const refusal = guard(state, action);
  if (refusal) return { state, refusal };
  const next = structuredClone(state);
  apply(next, action, at);
  schedule(next, at);
  return { state: next, refusal: null };
}
