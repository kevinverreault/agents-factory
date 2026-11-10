// The Runs screen: every run in the factory, live ones first.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryState, RunView } from '../protocol/factory-state.ts';
import { overall, tokensOf } from '../usage/usage.ts';
import { CursorWindow, fixed } from './screen.ts';
import { Cursor, tone, type Role } from './theme.ts';
import { tokens } from './usage.ts';

// Live runs (active or suspended) first, then the ended ones, each newest first.
export function liveFirst(state: FactoryState): RunView[] {
  const live = (run: RunView) => (run.status === 'ended' ? 1 : 0);
  return Object.values(state.runs).sort((a, b) => live(a) - live(b) || b.startedAt - a.startedAt);
}

// A task's runs, oldest first.
export function runsOf(state: FactoryState, taskId: string): RunView[] {
  return Object.values(state.runs)
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

// How a run ended, or that it is live or suspended.
export function runOutcome(run: RunView): string {
  if (run.waitingForWindow !== null) return 'waiting for window';
  return run.outcome ?? (run.status === 'active' ? 'live' : run.status);
}

// The columns' widths, which the row naming them shares.
const COLUMNS: [name: string, width: number][] = [
  ['run', 4],
  ['task', 4],
  ['title', 24],
  ['mode', 4],
  ['stage', 10],
  ['model', 18],
  ['status', 19],
];
const TOKENS_WIDTH = 7;

// Every run under a dim row naming its columns: a live one bright, its
// status lit, and an ended one dim.
export function RunsList({ state, runs, cursor }: { state: FactoryState; runs: RunView[]; cursor: number }) {
  if (runs.length === 0) return h(Text, tone('dim'), 'No runs yet.');
  const cell = (width: number, text: string, role: Role, bold = false) => h(Box, { width, flexShrink: 0 }, h(Text, { ...tone(role), bold, wrap: 'truncate' }, text));
  const tokensCell = (text: string, role: Role) => h(Box, { width: TOKENS_WIDTH, flexShrink: 0, justifyContent: 'flex-end' }, h(Text, tone(role), text));
  return h(
    Box,
    { flexDirection: 'column' },
    fixed(h(Box, { gap: 1 }, h(Cursor, { on: false }), ...COLUMNS.map(([name, width]) => cell(width, name, 'dim')), tokensCell('tokens', 'dim'))),
    h(CursorWindow, {
      cursor,
      items: runs.map((run, i) => {
        const role: Role = run.status === 'ended' ? 'dim' : 'fg';
        const cells = [run.id, run.taskId, state.tasks[run.taskId]?.title ?? '', run.mode, run.stage ?? '—', run.model, runOutcome(run)];
        return h(
          Box,
          { key: run.id, gap: 1 },
          h(Cursor, { on: i === cursor }),
          ...cells.map((text, at) => cell(COLUMNS[at]![1], text, at === cells.length - 1 && role === 'fg' ? 'ok' : role, at === 0 && i === cursor)),
          tokensCell(tokens(tokensOf(overall(run.usage))), 'dim'),
        );
      }),
    }),
  );
}
