// What runs used, as the TUI shows it (ADR 0008): the Usage tab, and a
// task's usage in its detail. Both are queries over the factory state's runs.
import { createElement as h, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { FactoryState } from '../protocol/factory-state.ts';
import { overall, tokensOf, usageViews, type ModelUsage, type Usage } from '../usage/usage.ts';
import { bar, GLYPH, Heading, spentRole, tone } from './theme.ts';

export function tokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function dollars(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

const KIND_WIDTH = 12;
const LABEL_WIDTH = 20;
const ID_WIDTH = 4;
const TITLE_WIDTH = 40;
const TOKENS_WIDTH = 16;
const COST_WIDTH = 10;

const GAUGE_LABEL_WIDTH = 22;
const GAUGE_CELLS = 40;
const TOKEN_BAR_CELLS = 20;

// The Usage tab: gauges of the usage windows, the slots and the last hours'
// tokens; then each model's tokens by kind and API-equivalent cost, then
// each task tree (by its root), group, stage and Ralph loop ticket that used
// anything. Each model's and group's tokens are barred against the largest.
export function UsageTab({ state }: { state: FactoryState }) {
  const views = usageViews(state);
  const gauges = h(Gauges, { state });
  if (Object.keys(views.models).length === 0) return h(Box, { flexDirection: 'column' }, gauges, h(Box, { marginTop: 1 }, h(Text, tone('dim'), 'No usage yet.')));
  const roots = Object.entries(views.trees).filter(([id]) => !state.tasks[id]?.parent);
  const section = (title: string, rows: [string, string | null, ModelUsage][], barred = false) => {
    const of = barred ? mostTokens(rows.map(([, , usage]) => overall(usage))) : 1;
    return rows.length === 0
      ? null
      : h(
          Box,
          { key: title, flexDirection: 'column', marginTop: 1 },
          h(Heading, { text: title }),
          ...rows.map(([key, label, usage]) => h(UsageRow, { key, name: key, label, usage: overall(usage), bar: barred ? tokensOf(overall(usage)) / of : null })),
        );
  };
  const models = Object.entries(views.models);
  const ofModels = mostTokens(models.map(([, usage]) => usage));
  return h(
    Box,
    { flexDirection: 'column' },
    gauges,
    h(Box, { marginTop: 1 }, h(KindsRow, { name: 'Model', cells: ['input', 'output', 'cache read', 'cache write', 'cost'], bold: true })),
    ...models.map(([model, usage]) => h(KindsRow, { key: model, name: model, cells: kinds(usage), bar: tokensOf(usage) / ofModels })),
    h(KindsRow, { key: 'total', name: 'Total', cells: kinds(overall(views.models)), bold: true }),
    section('Task trees', roots.map(([id, usage]) => [id, state.tasks[id]?.title ?? '', usage])),
    section('Groups', Object.entries(views.groups).map(([group, usage]) => [group, null, usage]), true),
    section('Stages', Object.entries(views.stages).map(([stage, usage]) => [stage, null, usage])),
    section('Tickets', Object.entries(views.tickets).map(([ticket, usage]) => [ticket, null, usage])),
  );
}

// The most tokens any of the usages has, to bar the others against: at least one.
function mostTokens(usages: Usage[]): number {
  return Math.max(1, ...usages.map(tokensOf));
}

// The usage windows spent, lit by how full they are, with when the 5-hour
// one resets; the slots taken and the tasks queued for one; and the last
// 12 hours' tokens.
function Gauges({ state }: { state: FactoryState }) {
  const { window, weekly, tokensPerHour } = state.usage;
  const { active, cap } = state.slots;
  // Only AFK work waits for a slot: a queued HITL task waits for the operator.
  const queued = Object.values(state.tasks).filter((task) => task.state === 'queued' && task.mode === 'AFK').length;
  const row = (label: string, ...value: ReactNode[]) =>
    h(Box, { key: label }, h(Box, { width: GAUGE_LABEL_WIDTH, flexShrink: 0 }, h(Text, null, label)), h(Text, { wrap: 'truncate' }, ...value));
  const spent = (share: number) => h(Text, tone(spentRole(share)), `${bar(share, GAUGE_CELLS)} ${percent(share)}`);
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0 },
    window ? row('5-hour window', spent(window.spent), h(Text, tone('dim'), ` · resets ${clockTime(window.resetsAt)}`)) : row('5-hour window', h(Text, tone('dim'), 'unknown')),
    weekly ? row('Weekly window', spent(weekly.spent)) : row('Weekly window', h(Text, tone('dim'), 'unknown')),
    row('Parallel slots', h(Text, tone('ok'), slots(active, cap)), ` ${active}/${cap} running · ${queued} queued`),
    row(`Tokens / hour, ${tokensPerHour.length}h`, h(Text, tone('accent'), sparkline(tokensPerHour)), h(Text, tone('dim'), ` ${tokens(tokensPerHour.at(-1) ?? 0)}/h now`)),
  );
}

function kinds(usage: Usage): string[] {
  return [tokens(usage.input), tokens(usage.output), tokens(usage.cacheRead), tokens(usage.cacheWrite), dollars(usage.cost)];
}

// `bar` is the row's share of the largest's tokens, if it is barred.
function TokenBar({ share }: { share: number | null | undefined }) {
  if (share === null || share === undefined) return null;
  return h(Box, { marginLeft: 2, flexShrink: 0 }, h(Text, tone('accent'), bar(share, TOKEN_BAR_CELLS)));
}

function KindsRow({ name, cells, bold = false, bar: share }: { name: string; cells: string[]; bold?: boolean; bar?: number }) {
  return h(
    Box,
    null,
    h(Box, { width: LABEL_WIDTH + 2, flexShrink: 0 }, h(Text, { bold, wrap: 'truncate' }, name)),
    ...cells.map((cell, i) => h(Box, { key: i, width: KIND_WIDTH, justifyContent: 'flex-end' }, h(Text, { bold }, cell))),
    h(TokenBar, { share }),
  );
}

function UsageRow({ name, label, usage, bar: share }: { name: string; label: string | null; usage: Usage; bar: number | null }) {
  return h(
    Box,
    { gap: 1 },
    // A task tree's root goes by its id and title, in the width a group, stage or ticket takes alone.
    h(Box, { width: label === null ? ID_WIDTH + 1 + TITLE_WIDTH : ID_WIDTH, flexShrink: 0 }, h(Text, { bold: label !== null, wrap: 'truncate' }, name)),
    label === null ? null : h(Box, { width: TITLE_WIDTH }, h(Text, { wrap: 'truncate' }, label)),
    h(Box, { width: TOKENS_WIDTH, justifyContent: 'flex-end' }, h(Text, null, `${tokens(tokensOf(usage))} tokens`)),
    h(Box, { width: COST_WIDTH, justifyContent: 'flex-end' }, h(Text, null, dollars(usage.cost))),
    h(TokenBar, { share }),
  );
}

// A task's usage per model, and its task tree's once it has children, for
// its detail.
export function TaskUsage({ state, taskId }: { state: FactoryState; taskId: string }) {
  const views = usageViews(state);
  const own = views.tasks[taskId] ?? {};
  const hasChildren = Object.values(state.tasks).some((task) => task.parent === taskId);
  const line = (key: string, name: string, usage: Usage, dim = false) =>
    h(
      Box,
      { key, gap: 1 },
      h(Box, { flexGrow: 1 }, h(Text, { ...tone(dim ? 'dim' : 'fg'), wrap: 'truncate' }, name)),
      h(Text, tone(dim ? 'dim' : 'fg'), tokens(tokensOf(usage))),
      h(Text, tone(dim ? 'dim' : 'fg'), dollars(usage.cost)),
    );
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0, marginBottom: 1 },
    h(Heading, { text: 'Usage' }),
    Object.keys(own).length === 0 ? h(Text, tone('dim'), 'None yet.') : null,
    ...Object.entries(own).map(([model, usage]) => line(model, model, usage)),
    hasChildren ? line('tree', 'task tree', overall(views.trees[taskId] ?? {}), true) : null,
  );
}

const BARS = '▁▂▃▄▅▆▇█';

// Each count as a bar, scaled to the largest: nothing is the lowest bar,
// and anything at all is at least the next one up.
export function sparkline(counts: number[]): string {
  const most = Math.max(0, ...counts);
  return counts.map((count) => BARS[count === 0 ? 0 : Math.max(1, Math.round((count / most) * (BARS.length - 1)))]).join('');
}

const percent = (spent: number) => `${Math.round(spent * 100)}%`;

// When a usage window resets, as a time of day in the machine's own zone:
// the 5-hour window always resets within the day.
function clockTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

// The always-on usage strip (ADR 0008): the usage window spent as a bar lit
// by how full it is, and when it resets; the weekly window's bar (each
// unknown without a snapshot to trust); slot occupancy; the last hours'
// tokens with this hour's; and every model's tokens. Its parts wrap onto a
// second line on a narrow terminal.
export function UsageStrip({ state }: { state: FactoryState }) {
  const { window, weekly, tokensPerHour } = state.usage;
  const { active, cap } = state.slots;
  const label = (text: string) => h(Text, tone('dim'), text);
  const spent = (share: number, cells: number) => h(Text, tone(spentRole(share)), `${bar(share, cells)} ${percent(share)}`);
  // Each part with what goes before it: `│` between the parts, `·` between
  // the models. On a line it wraps, the divider ends the line it breaks.
  const parts: [string | null, ReactNode[]][] = [
    [null, window ? [label('window '), spent(window.spent, 14), label(` ${GLYPH.resets}`), clockTime(window.resetsAt)] : [label('window '), 'unknown']],
    [GLYPH.divider, weekly ? [label('week '), spent(weekly.spent, 6)] : [label('week '), 'unknown']],
    [GLYPH.divider, [label('slots '), h(Text, tone('ok'), slots(active, cap)), ` ${active}/${cap}`]],
    [GLYPH.divider, [h(Text, tone('accent'), sparkline(tokensPerHour)), ` ${tokens(tokensPerHour.at(-1) ?? 0)}/h`]],
    ...Object.entries(usageViews(state).models).map(([model, usage], i): [string, ReactNode[]] => [i === 0 ? GLYPH.divider : '·', [label(`${model} `), tokens(tokensOf(usage))]]),
  ];
  return h(
    Box,
    { flexWrap: 'wrap', flexShrink: 0 },
    ...parts.map(([, part], i) => {
      const after = parts[i + 1]?.[0];
      return h(Text, { key: i }, ...part, after ? label(` ${after} `) : null);
    }),
  );
}

// Slots taken, then free, a glyph each: past the cap, those over it as a count.
function slots(active: number, cap: number): string {
  const over = active - cap;
  return GLYPH.slotTaken.repeat(Math.min(active, cap)) + GLYPH.slotFree.repeat(Math.max(cap - active, 0)) + (over > 0 ? ` +${over}` : '');
}
