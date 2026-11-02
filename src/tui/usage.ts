// What runs used, as the TUI shows it (ADR 0008): the Usage tab, and a
// task's usage in its detail. Both are queries over the factory state's runs.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryState } from '../protocol/factory-state.ts';
import { overall, tokensOf, usageViews, type ModelUsage, type Usage } from '../usage/usage.ts';

function tokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function dollars(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

const KIND_WIDTH = 12;
const LABEL_WIDTH = 20;
const ID_WIDTH = 4;
const TITLE_WIDTH = 40;
const TOKENS_WIDTH = 16;
const COST_WIDTH = 10;

// Each model's tokens by kind and API-equivalent cost, then each task tree
// (by its root), group, stage and Ralph loop ticket that used anything.
export function UsageTab({ state }: { state: FactoryState }) {
  const views = usageViews(state);
  if (Object.keys(views.models).length === 0) return h(Text, { dimColor: true }, 'No usage yet.');
  const roots = Object.entries(views.trees).filter(([id]) => !state.tasks[id]?.parent);
  const section = (title: string, rows: [string, string | null, ModelUsage][]) =>
    rows.length === 0
      ? null
      : h(
          Box,
          { key: title, flexDirection: 'column', marginTop: 1 },
          h(Text, { bold: true }, title),
          ...rows.map(([key, label, usage]) => h(UsageRow, { key, name: key, label, usage: overall(usage) })),
        );
  return h(
    Box,
    { flexDirection: 'column' },
    h(KindsRow, { key: 'head', name: 'Model', cells: ['input', 'output', 'cache read', 'cache write', 'cost'], bold: true }),
    ...Object.entries(views.models).map(([model, usage]) => h(KindsRow, { key: model, name: model, cells: kinds(usage) })),
    h(KindsRow, { key: 'total', name: 'Total', cells: kinds(overall(views.models)), bold: true }),
    section('Task trees', roots.map(([id, usage]) => [id, state.tasks[id]?.title ?? '', usage])),
    section('Groups', Object.entries(views.groups).map(([group, usage]) => [group, null, usage])),
    section('Stages', Object.entries(views.stages).map(([stage, usage]) => [stage, null, usage])),
    section('Tickets', Object.entries(views.tickets).map(([ticket, usage]) => [ticket, null, usage])),
  );
}

function kinds(usage: Usage): string[] {
  return [tokens(usage.input), tokens(usage.output), tokens(usage.cacheRead), tokens(usage.cacheWrite), dollars(usage.cost)];
}

function KindsRow({ name, cells, bold = false }: { name: string; cells: string[]; bold?: boolean }) {
  return h(
    Box,
    null,
    h(Box, { width: LABEL_WIDTH + 2, flexShrink: 0 }, h(Text, { bold, wrap: 'truncate' }, name)),
    ...cells.map((cell, i) => h(Box, { key: i, width: KIND_WIDTH, justifyContent: 'flex-end' }, h(Text, { bold }, cell))),
  );
}

function UsageRow({ name, label, usage }: { name: string; label: string | null; usage: Usage }) {
  return h(
    Box,
    { gap: 1 },
    // A task tree's root goes by its id and title, in the width a group, stage or ticket takes alone.
    h(Box, { width: label === null ? ID_WIDTH + 1 + TITLE_WIDTH : ID_WIDTH, flexShrink: 0 }, h(Text, { bold: label !== null, wrap: 'truncate' }, name)),
    label === null ? null : h(Box, { width: TITLE_WIDTH }, h(Text, { wrap: 'truncate' }, label)),
    h(Box, { width: TOKENS_WIDTH, justifyContent: 'flex-end' }, h(Text, null, `${tokens(tokensOf(usage))} tokens`)),
    h(Box, { width: COST_WIDTH, justifyContent: 'flex-end' }, h(Text, null, dollars(usage.cost))),
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
      h(Box, { flexGrow: 1 }, h(Text, { dimColor: dim, wrap: 'truncate' }, name)),
      h(Text, { dimColor: dim }, tokens(tokensOf(usage))),
      h(Text, { dimColor: dim }, dollars(usage.cost)),
    );
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0, marginBottom: 1 },
    h(Text, { bold: true }, 'Usage'),
    Object.keys(own).length === 0 ? h(Text, { dimColor: true }, 'None yet.') : null,
    ...Object.entries(own).map(([model, usage]) => line(model, model, usage)),
    hasChildren ? line('tree', 'task tree', overall(views.trees[taskId] ?? {}), true) : null,
  );
}
