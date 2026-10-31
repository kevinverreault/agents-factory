// The factory-state subscription's view: what every attached TUI sees. A
// subscriber gets one snapshot, then patches that turn its copy into the
// daemon's current state.
import {
  activeAfkRuns,
  attentionQueue,
  label,
  lastUsedRepo,
  liveRun,
  nextTier,
  readyForYou,
  type AutonomyLevel,
  type FrozenPreset,
  type Lifecycle,
  type Mode,
  type Priority,
  type AttentionQueueItem,
  type Artifact,
  type Repository,
  type Run,
  type TaskState,
} from '../lifecycle/lifecycle.ts';
import type { Tier } from '../models/routing.ts';

export type TaskView = {
  id: string;
  title: string;
  repo: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  priority: Priority;
  groups: string[];
  state: TaskState;
  label: string;
  liveRunId: string | null;
  branch: string | null;
  worktree: string | null;
  // The Claude session the task's conversation lives in.
  sessionId: string | null;
  skillSet: string | null;
  // The preset frozen at launch, and the stage the task is at.
  preset: FrozenPreset | null;
  stage: string | null;
  // The tier its next run starts at.
  tier: Tier;
};

export type RunView = Pick<
  Run,
  'id' | 'taskId' | 'mode' | 'autonomy' | 'status' | 'outcome' | 'turn' | 'queued' | 'question' | 'stage' | 'proposal' | 'model' | 'cli' | 'skillSet' | 'startedAt' | 'endedAt'
> & { maxTurns: number | null; tier: Tier | null };

export type RepositoryView = Pick<Repository, 'id' | 'path' | 'baseBranch' | 'defaultPreset' | 'missing'>;

// A file or issue linked to its task, in the order captured.
export type ArtifactView = Artifact;

export type FactoryState = {
  repositories: Record<string, RepositoryView>;
  tasks: Record<string, TaskView>;
  runs: Record<string, RunView>;
  artifacts: Record<string, ArtifactView>;
  attentionQueue: AttentionQueueItem[];
  slots: { active: number; cap: number };
  // Where a launch card goes when the working directory is in no registered clone.
  lastUsedRepo: string | null;
};

// `watched` holds the runs whose conversations a TUI has open.
export function toFactoryState(lifecycle: Lifecycle, watched: ReadonlySet<string> = new Set()): FactoryState {
  const repositories: Record<string, RepositoryView> = {};
  for (const repository of Object.values(lifecycle.repositories)) repositories[repository.id] = repositoryView(repository);
  const tasks: Record<string, TaskView> = {};
  for (const task of Object.values(lifecycle.tasks)) {
    tasks[task.id] = {
      id: task.id,
      title: task.title,
      repo: task.repo,
      mode: task.mode,
      autonomy: task.autonomy,
      priority: task.priority ?? 'normal',
      groups: task.groups,
      state: task.state,
      label: label(task, readyForYou(lifecycle, task, watched)),
      liveRunId: liveRun(lifecycle, task)?.id ?? null,
      branch: task.worktree?.branch ?? null,
      worktree: task.worktree?.path ?? null,
      sessionId: task.sessionId,
      skillSet: task.skillSet ?? null,
      preset: structuredClone(task.preset ?? null),
      stage: task.stage ?? null,
      tier: nextTier(task),
    };
  }
  const runs: Record<string, RunView> = {};
  for (const run of Object.values(lifecycle.runs)) {
    const { id, taskId, mode, autonomy, status, outcome, turn, queued, question, model, cli, skillSet, startedAt, endedAt } = run;
    // Runs stored before stages, proposals, max turns and tiers have none.
    const stage = run.stage ?? null;
    const proposal = run.proposal ?? null;
    const maxTurns = run.maxTurns ?? null;
    const tier = run.tier ?? null;
    runs[id] = {
      id,
      taskId,
      mode,
      autonomy,
      status,
      outcome,
      turn,
      queued,
      question,
      stage,
      proposal,
      tier,
      model,
      maxTurns,
      cli,
      skillSet: skillSet ?? null,
      startedAt,
      endedAt,
    };
  }
  return {
    repositories,
    tasks,
    runs,
    artifacts: structuredClone(lifecycle.artifacts),
    attentionQueue: attentionQueue(lifecycle, watched),
    slots: { active: activeAfkRuns(lifecycle), cap: lifecycle.slotCap },
    lastUsedRepo: lastUsedRepo(lifecycle),
  };
}

export function repositoryView({ id, path, baseBranch, defaultPreset, missing }: Repository): RepositoryView {
  return { id, path, baseBranch, defaultPreset, missing };
}

// A patch sets or deletes the value at a path. The diff goes two levels deep
// (a collection, then one entity in it); anything deeper is replaced whole.
export type PatchOp = { op: 'set'; path: string[]; value: unknown } | { op: 'delete'; path: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffAt(path: string[], before: unknown, after: unknown, depth: number, ops: PatchOp[]): void {
  if (same(before, after)) return;
  if (depth === 0 || !isRecord(before) || !isRecord(after)) {
    ops.push({ op: 'set', path, value: after });
    return;
  }
  for (const key of Object.keys(before)) if (!(key in after)) ops.push({ op: 'delete', path: [...path, key] });
  for (const key of Object.keys(after)) diffAt([...path, key], before[key], after[key], depth - 1, ops);
}

export function diffFactoryState(before: FactoryState, after: FactoryState): PatchOp[] {
  const ops: PatchOp[] = [];
  diffAt([], before, after, 2, ops);
  return ops;
}

export function applyPatch(state: FactoryState, ops: PatchOp[]): FactoryState {
  const next = structuredClone(state) as unknown as Record<string, unknown>;
  for (const op of ops) {
    const parent = op.path.slice(0, -1).reduce((node, key) => node[key] as Record<string, unknown>, next);
    const key = op.path.at(-1)!;
    if (op.op === 'set') parent[key] = structuredClone(op.value);
    else delete parent[key];
  }
  return next as unknown as FactoryState;
}
