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
