// The Runs screen: every run in the factory, live ones first.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryState, RunView } from '../protocol/factory-state.ts';
import { overall, tokensOf } from '../usage/usage.ts';
import { CursorWindow, fixed } from './screen.ts';
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

export function RunsList({ state, runs, cursor }: { state: FactoryState; runs: RunView[]; cursor: number }) {
  if (runs.length === 0) return h(Text, { dimColor: true }, 'No runs yet.');
  const cell = (width: number, text: string, props: object = {}) => h(Box, { width, flexShrink: 0 }, h(Text, { wrap: 'truncate', ...props }, text));
  return h(
    Box,
    { flexDirection: 'column' },
    h(CursorWindow, {
      cursor,
      items: runs.map((run, i) =>
        h(
          Box,
          { key: run.id, gap: 1 },
          h(Text, { color: 'cyan' }, i === cursor ? '›' : ' '),
          cell(4, run.id, { bold: true }),
          cell(4, run.taskId),
          cell(24, state.tasks[run.taskId]?.title ?? ''),
          cell(4, run.mode),
          cell(10, run.stage ?? '—'),
          cell(18, run.model),
          cell(19, runOutcome(run), run.status === 'ended' ? { dimColor: true } : { color: 'green' }),
          h(Box, { width: 7, flexShrink: 0, justifyContent: 'flex-end' }, h(Text, { dimColor: true }, tokens(tokensOf(overall(run.usage))))),
        ),
      ),
    }),
  );
}
