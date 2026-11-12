// Usage metering (ADR 0008): what runs used, per model, and every view of
// it as a query over runs. Nothing here is a stored counter, so the views
// always agree with each other.

// Tokens by kind, and their API-equivalent cost in USD.
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
// Usage by exact model ID.
export type ModelUsage = Record<string, Usage>;

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const FIELDS = Object.keys(NO_USAGE) as (keyof Usage)[];

function each(f: (field: keyof Usage) => number): Usage {
  return Object.fromEntries(FIELDS.map((field) => [field, f(field)])) as Usage;
}

export const plus = (a: Usage, b: Usage): Usage => each((field) => a[field] + b[field]);
const minus = (a: Usage, b: Usage): Usage => each((field) => a[field] - b[field]);
const isZero = (usage: Usage): boolean => FIELDS.every((field) => usage[field] === 0);
// Every token, of whatever kind.
export const tokensOf = ({ input, output, cacheRead, cacheWrite }: Usage): number => input + output + cacheRead + cacheWrite;

// What a message streamed again adds to what was counted for it: only what
// grew, as a later content block of it may count more output.
export const grown = (counted: Usage, now: Usage): Usage => each((field) => Math.max(0, now[field] - counted[field]));

// The records added up, model by model. Models whose usage is all zero drop out.
export function merged(...records: ModelUsage[]): ModelUsage {
  const sum: ModelUsage = {};
  for (const record of records) for (const [model, usage] of Object.entries(record)) sum[model] = plus(sum[model] ?? NO_USAGE, usage);
  for (const [model, usage] of Object.entries(sum)) if (isZero(usage)) delete sum[model];
  return sum;
}

// Every model's usage together.
export function overall(record: ModelUsage): Usage {
  return Object.values(record).reduce(plus, NO_USAGE);
}

// What brings a run's record into line with its session's total so far
// (`result.modelUsage`): the total less what the session's other runs
// recorded, a resumed session's total counting theirs. A model the total
// doesn't name gets nothing. A total that is all zero, as a crashed CLI's
// result may be, corrects nothing, and neither does a model's total below
// what the other runs recorded: the CLI didn't carry their totals, or a
// `/clear` reset it, so it can't say what this run used. (A `/clear` within
// a session's first run goes unseen: the run keeps only what came after it.)
export function correction(total: ModelUsage, others: ModelUsage, mine: ModelUsage): ModelUsage {
  const change: ModelUsage = {};
  if (isZero(overall(total))) return change;
  for (const [model, usage] of Object.entries(total)) {
    const before = others[model] ?? NO_USAGE;
    if (FIELDS.some((field) => usage[field] < before[field])) continue;
    change[model] = minus(minus(usage, before), mine[model] ?? NO_USAGE);
  }
  for (const [model, usage] of Object.entries(mine)) if (!(model in total)) change[model] = minus(NO_USAGE, usage);
  return change;
}

// What a view needs of a run and of a task: the factory state's runs and
// tasks are these.
export type MeteredRun = { taskId: string; stage: string | null; ticket: string | null; usage: ModelUsage };
export type MeteredTask = { id: string; parent: string | null; groups: string[] };

// Every usage view, each keyed by what it groups runs by: by model; by task;
// by task tree, under every task in it the run's task descends from or is;
// by group; by stage id across tasks; and by Ralph loop ticket.
export type UsageViews = {
  models: ModelUsage;
  tasks: Record<string, ModelUsage>;
  trees: Record<string, ModelUsage>;
  groups: Record<string, ModelUsage>;
  stages: Record<string, ModelUsage>;
  tickets: Record<string, ModelUsage>;
};

export function usageViews({ runs, tasks }: { runs: Record<string, MeteredRun>; tasks: Record<string, MeteredTask> }): UsageViews {
  const views: UsageViews = { models: {}, tasks: {}, trees: {}, groups: {}, stages: {}, tickets: {} };
  const add = (view: Record<string, ModelUsage>, key: string, usage: ModelUsage) => (view[key] = merged(view[key] ?? {}, usage));
  for (const { taskId, stage, ticket, usage } of Object.values(runs)) {
    if (Object.keys(usage).length === 0) continue;
    views.models = merged(views.models, usage);
    add(views.tasks, taskId, usage);
    for (let id: string | null = taskId; id !== null; id = tasks[id]?.parent ?? null) add(views.trees, id, usage);
    for (const group of tasks[taskId]?.groups ?? []) add(views.groups, group, usage);
    if (stage !== null) add(views.stages, stage, usage);
    if (ticket !== null) add(views.tickets, ticket, usage);
  }
  return views;
}

// Usage windows (ADR 0008), as `rate_limit_event`s and the CLI's `/usage` name them: the 5-hour
// one, the weekly one, and the weekly ones per model or with overage.
export type UsageWindowKind = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';
export type UsageWindowStatus = 'allowed' | 'allowed_warning' | 'rejected';

// The usage windows each run's requests count against.
export type UsageSnapshots = Partial<Record<UsageWindowKind, UsageSnapshot>>;

// Whether `window` is a weekly one that a run on `model` spends: a model's
// own weekly window spends only that model's runs.
function weeklyFor(window: UsageWindowKind, model: string): boolean {
  if (window === 'seven_day_opus') return model.includes('opus');
  if (window === 'seven_day_sonnet') return model.includes('sonnet');
  return window.startsWith('seven_day');
}

// The factory's latest reading of a usage window, as a run saw it: the share
// of it spent (0 to 1), when it resets, in ms, and when it was seen. Nothing
// gates on it; a weekly one spent only says why an AFK run fails (ADR 0008).
export type UsageSnapshot = {
  window: UsageWindowKind;
  status: UsageWindowStatus;
  spent: number | null;
  resetsAt: number | null;
  seenAt: number;
};

// How long a snapshot is trusted once seen: a run sees a new one whenever
// the window's reading changes, so one this old says nothing of the window
// now, the operator's own chat spending it too. A spent window's stays
// spent until its reset, however old.
export const SNAPSHOT_TRUST_MS = 60 * 60_000;

// A window as a reading shows it: what is spent and when it resets, or null
// (unknown) once the snapshot is past its reset or too old to trust.
export type WindowView = { spent: number; resetsAt: number } | null;

export function windowView(snapshot: UsageSnapshot | undefined, at: number): WindowView {
  if (!snapshot || snapshot.spent === null || snapshot.resetsAt === null) return null;
  if (snapshot.resetsAt <= at || (snapshot.status !== 'rejected' && snapshot.seenAt + SNAPSHOT_TRUST_MS < at)) return null;
  return { spent: snapshot.spent, resetsAt: snapshot.resetsAt };
}

// How far apart two readings' resets may be and still be the same window's:
// the CLI's `/usage` names them to the millisecond, its `rate_limit_event`s
// to the second.
const SAME_RESET_MS = 60_000;

// The window's reading `seen` brings: what it says, and what was spent as
// the last reading had it when it says nothing of that for the same window.
export function updatedSnapshot(last: UsageSnapshot | undefined, seen: UsageSnapshot): UsageSnapshot {
  if (seen.spent !== null || !last) return seen;
  const sameReset = last.resetsAt === seen.resetsAt || (last.resetsAt !== null && seen.resetsAt !== null && Math.abs(last.resetsAt - seen.resetsAt) <= SAME_RESET_MS);
  return sameReset ? { ...seen, spent: last.spent } : seen;
}

const HOUR_MS = 3_600_000;
// How many hours the tokens-per-hour sparkline covers.
const SPARKLINE_HOURS = 12;

// Every run's tokens in each of the last `hours` hours, oldest first and the
// hour `at` is in last, from their per-minute samples (each from `minute`, in ms).
export function tokensPerHour(samples: Iterable<{ minute: number; models: ModelUsage }>, at: number, hours = SPARKLINE_HOURS): number[] {
  const counts = new Array<number>(hours).fill(0);
  const last = Math.floor(at / HOUR_MS);
  for (const { minute, models } of samples) {
    const ago = last - Math.floor(minute / HOUR_MS);
    if (ago >= 0 && ago < hours) counts[hours - 1 - ago]! += tokensOf(overall(models));
  }
  return counts;
}

// When a usage window resets, in the machine's own time zone: its weekday,
// date and time.
export function resetTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

// When the weekly usage window a run on `model` spends resets, if the
// snapshots show it spent at `at`: the latest such reset.
export function weeklySpentUntil(snapshots: UsageSnapshots, model: string, at: number): number | null {
  let until: number | null = null;
  for (const { window, status, resetsAt } of Object.values(snapshots)) {
    if (!weeklyFor(window, model) || status !== 'rejected' || resetsAt === null || resetsAt <= at) continue;
    if (until === null || resetsAt > until) until = resetsAt;
  }
  return until;
}
