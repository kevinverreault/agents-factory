// The Lifecycle: tasks, runs and attention requests as a pure reducer with
// guards and selectors. Every operator command and every run event goes
// through `reduce`. Ported from the task-lifecycle prototype, amended by
// ADR 0003 (`interrupted`) and ADR 0008 (no usage-window stop, no budget).
// Child tasks, stages and parking arrive with their own slices.

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

export type Task = {
  id: string;
  title: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  groups: string[];
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
  startedAt: number;
  endedAt: number | null;
};

export type AttentionRequest = {
  id: string;
  taskId: string;
  runId: string;
  kind: AttentionKind;
  status: AttentionStatus;
  // True while the request keeps its run suspended; false once the run ended.
  holdsRun: boolean;
  reason: string | null;
  raisedAt: number;
};

export type Lifecycle = {
  counters: { task: number; run: number; request: number };
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  requests: Record<string, AttentionRequest>;
  slotCap: number;
};

// The operator's verbs.
export type OperatorCommand =
  | { type: 'createTask'; title: string; mode: Mode; autonomy?: AutonomyLevel; groups?: string[]; submit?: boolean }
  | { type: 'submit'; taskId: string }
  | { type: 'open'; taskId: string }
  | { type: 'handoff'; taskId: string; autonomy: AutonomyLevel }
  | { type: 'takeOver'; taskId: string }
  | { type: 'answer'; taskId: string }
  | { type: 'requestChanges'; taskId: string }
  | { type: 'markDone'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'setSlotCap'; cap: number };

// What the executor reports about a run.
export type RunEvent =
  | { type: 'runCompleted'; runId: string }
  | { type: 'runFailed'; runId: string; reason: string }
  | { type: 'attentionRaised'; runId: string; kind: 'question' | 'permission'; reason?: string };

export type LifecycleAction = OperatorCommand | RunEvent;

export type Reduction = { state: Lifecycle; refusal: string | null };

export const DEFAULT_SLOT_CAP = 2;

export function initialLifecycle(): Lifecycle {
  return { counters: { task: 0, run: 0, request: 0 }, tasks: {}, runs: {}, requests: {}, slotCap: DEFAULT_SLOT_CAP };
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

export function activeAfkRuns(state: Lifecycle): number {
  return Object.values(state.runs).filter((run) => run.status === 'active' && run.mode === 'AFK').length;
}

export function label(task: Task): string {
  switch (task.state) {
    case 'draft':
      return 'Draft';
    case 'queued':
      return task.mode === 'HITL' ? 'Ready for you' : 'Queued';
    case 'running':
      return task.mode === 'HITL' ? 'In conversation' : 'Running';
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
  | { kind: 'attention'; taskId: string; requestId: string; attention: AttentionKind; holdsRun: boolean; reason: string | null }
  | { kind: 'ready'; taskId: string }
  | { kind: 'review'; taskId: string };

// Everything waiting on the operator, in task order.
export function attentionQueue(state: Lifecycle): AttentionQueueItem[] {
  const items: AttentionQueueItem[] = [];
  for (const task of Object.values(state.tasks)) {
    const request = openRequest(state, task);
    if (task.state === 'waiting' && request) {
      items.push({
        kind: 'attention',
        taskId: task.id,
        requestId: request.id,
        attention: request.kind,
        holdsRun: request.holdsRun,
        reason: request.reason,
      });
    }
    if (task.state === 'queued' && task.mode === 'HITL') items.push({ kind: 'ready', taskId: task.id });
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
  const task = taskOf(state, action)!;
  switch (action.type) {
    case 'createTask':
      return action.title.trim() ? null : 'A task needs a title.';
    case 'submit':
      return task.state === 'draft' ? null : 'Only a draft can be submitted.';
    case 'open':
      if (task.mode !== 'HITL') return `${task.id} is AFK. Take it over to talk to it.`;
      return task.state === 'draft' || task.state === 'queued'
        ? null
        : `${task.id} isn't ready for a conversation (it is ${label(task)}).`;
    case 'handoff':
      return task.mode === 'HITL' && task.state === 'running'
        ? null
        : 'Only a task in a live HITL conversation can be handed off.';
    case 'takeOver':
      return task.mode === 'AFK' && ['queued', 'running', 'waiting'].includes(task.state)
        ? null
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
    case 'runCompleted':
    case 'runFailed':
      return null;
    case 'attentionRaised':
      return task.mode === 'HITL' ? 'In a HITL run the agent asks in the conversation, not with an attention request.' : null;
  }
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
    resumesSession: task.sessionId !== null,
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

// Starts queued AFK tasks, first in first out, while a slot is free.
function schedule(state: Lifecycle, at: number): void {
  for (const task of Object.values(state.tasks)) {
    if (activeAfkRuns(state) >= state.slotCap) return;
    if (task.state === 'queued' && task.mode === 'AFK') startRun(state, task, at);
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
        mode: action.mode,
        autonomy: action.mode === 'AFK' ? (action.autonomy ?? 'L1') : null,
        groups: [...(action.groups ?? [])],
        sessionId: null,
        runIds: [],
        state: action.submit ? 'queued' : 'draft',
        createdAt: at,
      };
      state.tasks[created.id] = created;
      break;
    }
    case 'submit':
      task.state = 'queued';
      break;
    case 'open':
      startRun(state, task, at);
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
