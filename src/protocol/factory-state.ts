// The factory-state subscription's view: what every attached TUI sees. A
// subscriber gets one snapshot, then patches that turn its copy into the
// daemon's current state.
import {
  atMergeGate,
  attentionQueue,
  heldSlots,
  keepsAwake,
  label,
  lastUsedRepo,
  liveRun,
  depthOf,
  nextTier,
  heldBack,
  readyForYou,
  treeRollup,
  type ChildReport,
  type Rollup,
  type AppCheck,
  type AutonomyLevel,
  type Cleanup,
  type FrontierTicket,
  type FrozenPreset,
  type HandoffSheet,
  type HandoffTicketSets,
  type Lifecycle,
  type MergeGate,
  type MergePolicy,
  type Mode,
  type Priority,
  type Publishing,
  type QuickLaunch,
  type AttentionQueueItem,
  type Artifact,
  type Repository,
  type Permission,
  type Run,
  type SkillsSetup,
  type TaskKind,
  type TaskState,
  type TicketResolution,
  type TicketSet,
} from '../lifecycle/lifecycle.ts';
import type { PullRequest } from '../github/github.ts';
import type { Tier } from '../models/routing.ts';
import { tokensPerHour, windowView, type ModelUsage, type WindowView } from '../usage/usage.ts';

export type TaskView = {
  id: string;
  title: string;
  repo: string;
  // The task that spawned it, for a child task, and how deep it is (a root is 0).
  parent: string | null;
  depth: number;
  // A child's place in its tree: whether its parent waits for it, the commit
  // its branch was cut from, and its report once it ended.
  child: { awaited: boolean; base: string; report: ChildReport | null } | null;
  // The one-line progress its agent last set through `report_progress`, while it is unfinished.
  progress: string | null;
  // Its descendants' counts, and their failures waiting on the operator.
  rollup: Rollup | null;
  // What kind of task it is (ADR 0013), plain for children and roots that
  // are neither a spec task nor a ticket task, and for a ticket task its
  // ticket. The merge policy its merge gate goes by, frozen once it went
  // AFK (ADR 0014).
  kind: TaskKind;
  ticket: string | null;
  mergePolicy: MergePolicy | null;
  // While it waits at an agent policy's merge gate: the checks on its PR's
  // head as last read (null until read), the factory's step merging it, and
  // why that step last failed.
  gate: GateView | null;
  // While the factory still owes a merged ticket task's ticket its closing,
  // and why it last couldn't.
  resolving: TicketResolution | null;
  // A ticket task's spec task, if one launched it (ADR 0013).
  specTask: string | null;
  // A spec task's ticket set: its spec, its tickets in order, the ticket
  // task launched on each so far, and why the factory last couldn't read or
  // launch them.
  ticketSet: TicketSetView | null;
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
  // The rules the operator allowed for the task.
  allowRules: string[];
  // The hosts the operator allowed its L2 runs to reach, besides the built-in ones.
  egressHosts: string[];
  // What its runs work towards: its first run's first message, or the brief
  // once handed off.
  goal: string | null;
  // Its open handoff sheet, if any.
  handoff: HandoffView | null;
  // Its quick launch while its grill is one: the questions answered so far.
  quick: QuickLaunch | null;
  // Its work loop over a map, while it is at a HITL loop stage: the ticket
  // the operator works. Between its tickets it offers the map's frontier, as
  // last read, or has `cleared` once the map had no open ticket left.
  loop: { ticket: string | null; frontier: FrontierTicket[] | null; cleared: boolean } | null;
  // Its launch summary, if the cheap run that named it wrote one.
  launchSummary: string | null;
  // Its PR body, once its PR body stage wrote it, and the PR title written with it, if any.
  prBody: string | null;
  prTitle: string | null;
  // Its Push & open draft PR while under way, and why its step last failed;
  // and the draft PR it opened.
  publishing: Publishing | null;
  pr: PullRequest | null;
  // Whether the factory pushed the task branch since its last run started.
  pushed: boolean;
  // While its cleanup, once it ended Done or Cancelled, hasn't finished, and why it last failed.
  cleanup: Cleanup | null;
  // Where its transcripts were archived once it ended.
  transcripts: string | null;
};

// A root's merge gate as the TUI shows it (ADR 0014).
export type GateView = { checks: MergeGate['checks'] | null; step: MergeGate['step']; problem: string | null };

export type HandoffView = Omit<HandoffSheet, 'asked' | 'ticketSets'> & { ticketSets: HandoffTicketSets | null };

export type RunView = Pick<
  Run,
  'id' | 'taskId' | 'mode' | 'autonomy' | 'status' | 'outcome' | 'interruption' | 'turn' | 'queued' | 'question' | 'stage' | 'proposal' | 'model' | 'cli' | 'skillSet' | 'startedAt' | 'endedAt'
> & {
  maxTurns: number | null;
  tier: Tier | null;
  ticket: string | null;
  usage: ModelUsage;
  permission: Permission | null;
  deniedHosts: string[];
  // While an AFK run waits out a 5-hour usage limit, when its wait ends.
  waitingForWindow: number | null;
};

// `app` is null until the daemon has checked the App's installation, and
// `skills` until it has checked the skill set's setup.
export type RepositoryView = Pick<Repository, 'id' | 'path' | 'baseBranch' | 'defaultPreset' | 'missing'> & {
  app: AppCheck | null;
  skills: SkillsSetup | null;
};

// A file or issue linked to its task, in the order captured.
export type ArtifactView = Artifact;

export type FactoryState = {
  repositories: Record<string, RepositoryView>;
  tasks: Record<string, TaskView>;
  runs: Record<string, RunView>;
  artifacts: Record<string, ArtifactView>;
  attentionQueue: AttentionQueueItem[];
  slots: { active: number; cap: number };
  // Whether the machine is kept from idle sleep while an AFK run is active.
  keepAwake: boolean;
  // Where a launch card goes when the working directory is in no registered clone.
  lastUsedRepo: string | null;
  usage: UsageSummary;
};

// What the usage strip shows besides the runs' own usage (ADR 0008): the
// 5-hour usage window and the weekly one, each null while unknown, and
// every run's tokens in each of the last hours, oldest first, the hour now last.
export type UsageSummary = { window: WindowView; weekly: WindowView; tokensPerHour: number[] };

// `watched` holds the runs whose conversations a TUI has open, and `at` is
// now: a usage snapshot past its reset or too old by then is unknown.
export function toFactoryState(lifecycle: Lifecycle, watched: ReadonlySet<string>, at: number): FactoryState {
  const repositories: Record<string, RepositoryView> = {};
  for (const repository of Object.values(lifecycle.repositories)) repositories[repository.id] = repositoryView(repository);
  const tasks: Record<string, TaskView> = {};
  for (const task of Object.values(lifecycle.tasks)) {
    const live = liveRun(lifecycle, task);
    tasks[task.id] = {
      id: task.id,
      title: task.title,
      repo: task.repo,
      parent: task.parent ?? null,
      depth: depthOf(task),
      child: task.child ? { awaited: task.child.awaited, base: task.child.base, report: structuredClone(task.child.report) } : null,
      progress: task.progress ?? null,
      rollup: treeRollup(lifecycle, task),
      kind: task.kind ?? 'plain',
      ticket: task.ticket ?? null,
      mergePolicy: task.mergePolicy ?? null,
      gate: atMergeGate(task) ? { checks: task.gate?.checks ?? null, step: task.gate?.step ?? null, problem: task.gate?.problem ?? null } : null,
      resolving: task.resolving ? { ...task.resolving } : null,
      specTask: task.specTask ?? null,
      ticketSet: task.ticketSet ? ticketSetView(lifecycle, task.ticketSet) : null,
      mode: task.mode,
      autonomy: task.autonomy,
      priority: task.priority ?? 'normal',
      groups: task.groups,
      state: task.state,
      label: live?.waitingForWindow ? 'Waiting for window' : label(task, readyForYou(lifecycle, task, watched)),
      liveRunId: live?.id ?? null,
      branch: task.worktree?.branch ?? null,
      worktree: task.worktree?.path ?? null,
      sessionId: task.sessionId,
      skillSet: task.skillSet ?? null,
      preset: structuredClone(task.preset ?? null),
      stage: task.stage ?? null,
      tier: nextTier(task),
      allowRules: [...(task.allowRules ?? [])],
      egressHosts: [...(task.egressHosts ?? [])],
      goal: task.goal,
      handoff: handoffView(task.handoff ?? null),
      quick: task.quick ? { ...task.quick } : null,
      loop: task.loop
        ? {
            ticket: task.loop.ticket,
            frontier: task.loop.frontier ? structuredClone(task.loop.frontier) : null,
            cleared: task.loop.cleared ?? false,
          }
        : null,
      launchSummary: task.launchSummary ?? null,
      prBody: task.prBody ?? null,
      prTitle: task.prTitle ?? null,
      publishing: task.publishing ? { ...task.publishing } : null,
      pr: task.pr ? { ...task.pr } : null,
      pushed: task.pushed ?? false,
      cleanup: task.cleanup ? { ...task.cleanup } : null,
      transcripts: task.transcripts ?? null,
    };
  }
  const runs: Record<string, RunView> = {};
  for (const run of Object.values(lifecycle.runs)) {
    const { id, taskId, mode, autonomy, status, outcome, turn, queued, question, model, cli, skillSet, startedAt, endedAt } = run;
    // Runs stored before interruptions were flagged have none.
    const interruption = run.interruption ?? null;
    // Runs stored before stages, proposals, max turns, tiers and permission cards have none,
    // and proposals stored before handoffs proposed advancing.
    const stage = run.stage ?? null;
    const proposal = run.proposal ? { ...run.proposal, kind: run.proposal.kind ?? 'advance' } : null;
    const maxTurns = run.maxTurns ?? null;
    const tier = run.tier ?? null;
    runs[id] = {
      id,
      taskId,
      mode,
      autonomy,
      status,
      outcome,
      interruption,
      turn,
      queued,
      question,
      permission: run.permission ?? null,
      deniedHosts: [...(run.deniedHosts ?? [])],
      stage,
      proposal,
      tier,
      model,
      maxTurns,
      ticket: run.ticket ?? null,
      usage: structuredClone(run.usage ?? {}),
      waitingForWindow: run.waitingForWindow ?? null,
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
    slots: { active: heldSlots(lifecycle), cap: lifecycle.slotCap },
    keepAwake: keepsAwake(lifecycle),
    lastUsedRepo: lastUsedRepo(lifecycle),
    usage: {
      window: windowView(lifecycle.snapshots.five_hour, at),
      weekly: windowView(lifecycle.snapshots.seven_day, at),
      tokensPerHour: tokensPerHour(Object.values(lifecycle.samples), at),
    },
  };
}

// The sheet as a TUI shows it: whether the brief was asked for yet is the daemon's.
function handoffView(sheet: HandoffSheet | null): HandoffView | null {
  if (!sheet) return null;
  const { asked, ...view } = structuredClone(sheet);
  return { ...view, ticketSets: view.ticketSets ?? null };
}

export function repositoryView({ id, path, baseBranch, defaultPreset, missing, app, skills }: Repository): RepositoryView {
  return { id, path, baseBranch, defaultPreset, missing, app: app ? { ...app } : null, skills: skills ? { ...skills } : null };
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

// A spec task's ticket set as the TUI sees it (ADR 0013): its spec, each of
// its tickets in order with where it stands, and why the factory last
// couldn't read the tickets or launch one.
export type TicketSetView = { spec: string | null; tickets: TicketView[]; problem: string | null };

// A ticket of a spec task, its title once read, and where it stands:
// launched on its ticket task, launching (on the frontier, its ticket task
// not made yet), waiting on its open blockers (none until the tickets are
// first read), held back by its label, skipped once its ticket task was
// cancelled, or merged: closed, its ticket task (if it had one) Done.
export type TicketView = { ref: string; title: string | null } & (
  | { state: 'launched'; taskId: string }
  | { state: 'launching' }
  | { state: 'waiting'; blockers: string[] }
  | { state: 'held-back' }
  | { state: 'skipped' }
  | { state: 'merged'; taskId: string | null }
);

// The ticket set's view, every ticket the set names, then any it launched
// that its last read no longer has.
function ticketSetView(lifecycle: Lifecycle, { spec, tickets, issues, toLaunch, launched, skipped, problem }: TicketSet): TicketSetView {
  const refs = [...new Set([...(issues.length ? issues.map(({ ref }) => ref) : tickets), ...Object.keys(launched)])];
  const view = (ref: string): TicketView => {
    const issue = issues.find((issue) => issue.ref === ref);
    const title = issue?.title ?? null;
    const taskId = launched[ref];
    if (taskId && lifecycle.tasks[taskId]?.state === 'done') return { ref, title, state: 'merged', taskId };
    if (issue && !issue.open) return { ref, title, state: 'merged', taskId: taskId ?? null };
    // A cancelled ticket task's ticket is skipped, though it was launched.
    if (skipped?.includes(ref)) return { ref, title, state: 'skipped' };
    if (taskId) return { ref, title, state: 'launched', taskId };
    if (toLaunch.includes(ref)) return { ref, title, state: 'launching' };
    // A ticket labelled for neither an agent nor the operator never launches, blocked or not.
    if (issue && heldBack(issue)) return { ref, title, state: 'held-back' };
    if (!issue || issue.openBlockers.length) return { ref, title, state: 'waiting', blockers: [...(issue?.openBlockers ?? [])] };
    return { ref, title, state: 'held-back' };
  };
  return { spec, tickets: refs.map(view), problem };
}
