// A task's detail, drilled into from a screen with `enter`: what it is, its
// runs, its usage and artifacts, and its output.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, RunView, TaskView } from '../protocol/factory-state.ts';
import { overall, tokensOf } from '../usage/usage.ts';
import { ArtifactRail } from './artifacts.ts';
import { Output } from './output.ts';
import { runOutcome, runsOf } from './runs.ts';
import { dollars, tokens, TaskUsage } from './usage.ts';

const OUTPUT_LINES = 12;

// `from` names the screen `esc` pops back to.
export function TaskDetail({ connection, state, task, from }: { connection: FactoryConnection; state: FactoryState; task: TaskView; from: string }) {
  const runs = runsOf(state, task.id);
  const facts = [
    task.autonomy ? `${task.mode} ${task.autonomy}` : task.mode,
    task.label,
    task.stage,
    task.tier,
    task.branch,
    task.groups.join(', '),
    task.parent ? `child of ${task.parent}` : null,
  ];
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: true, wrap: 'truncate' }, `${from} › ${task.id} ${task.title}`),
    h(Box, { gap: 2, marginTop: 1 }, h(Text, { bold: true }, task.id), h(Text, { wrap: 'truncate' }, task.title)),
    h(Text, { dimColor: true, wrap: 'truncate' }, facts.filter(Boolean).join(' · ')),
    task.progress ? h(Text, { wrap: 'truncate' }, task.progress) : null,
    h(
      Box,
      { flexDirection: 'column', marginY: 1 },
      h(Text, { bold: true }, 'Runs'),
      runs.length === 0 ? h(Text, { dimColor: true }, 'None yet.') : null,
      ...runs.map((run) => h(RunRow, { key: run.id, run })),
    ),
    h(TaskUsage, { state, taskId: task.id }),
    h(ArtifactRail, { artifacts: Object.values(state.artifacts).filter((artifact) => artifact.taskId === task.id) }),
    h(Output, { connection, state, taskId: task.id, lines: OUTPUT_LINES }),
    h(Text, { dimColor: true }, 'enter open conversation · c converse or take over · a answer · x cancel · esc back · ? keys'),
  );
}

function RunRow({ run }: { run: RunView }) {
  const used = overall(run.usage);
  const cell = (width: number, text: string, right = false) =>
    h(Box, { width, flexShrink: 0, justifyContent: right ? 'flex-end' : 'flex-start' }, h(Text, { wrap: 'truncate' }, text));
  return h(
    Box,
    { gap: 1 },
    cell(4, run.id),
    cell(4, run.mode),
    cell(14, run.stage ?? '—'),
    cell(20, run.model),
    cell(20, runOutcome(run)),
    cell(8, tokens(tokensOf(used)), true),
    cell(8, dollars(used.cost), true),
  );
}
