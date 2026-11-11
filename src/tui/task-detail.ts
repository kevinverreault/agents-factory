// A task's detail, drilled into from a screen with `enter`: its title, what
// it is on one line, its open request, its runs, its usage and artifacts,
// and its output whole.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, RunView, TaskView } from '../protocol/factory-state.ts';
import { overall, tokensOf } from '../usage/usage.ts';
import { answerable, askedFor } from './answer-sheet.ts';
import { ArtifactRail } from './artifacts.ts';
import { Output } from './output.ts';
import { runOutcome, runsOf } from './runs.ts';
import { fixed } from './screen.ts';
import { GLYPH, joined, kindLook, Section, Sheet, stateLook, tone } from './theme.ts';
import { dollars, tokens, TaskUsage } from './usage.ts';

export function TaskDetail({ connection, state, task }: { connection: FactoryConnection; state: FactoryState; task: TaskView }) {
  const runs = runsOf(state, task.id);
  // The model its live run is on, or its last run was.
  const model = (task.liveRunId ? state.runs[task.liveRunId] : runs.at(-1))?.model;
  const parent = task.parent ? state.tasks[task.parent] : undefined;
  const child = task.parent ? `child of ${task.parent}${parent ? ` ${parent.title}` : ''}${task.child ? (task.child.awaited ? ' (awaited)' : ' (fire-and-forget)') : ''}` : null;
  const before = [modeOf(task)];
  const after = [task.stage, model, task.tier, task.branch, task.groups.join(', '), child].filter((part): part is string => Boolean(part));
  const request = state.attentionQueue.find((item) => item.kind === 'attention' && item.taskId === task.id);
  return h(
    Box,
    { flexDirection: 'column' },
    // On a short screen only the output gives way.
    fixed(
      h(Text, { ...tone('fg'), bold: true, wrap: 'truncate' }, `${task.id} ${task.title}`),
      h(
        Text,
        { ...tone('dim'), wrap: 'truncate' },
        `${joined(before)} ${GLYPH.between} `,
        h(Text, tone(stateLook(task.label).role), task.label),
        after.length ? ` ${GLYPH.between} ${joined(after)}` : '',
      ),
      task.progress ? h(Text, { wrap: 'truncate' }, task.progress) : null,
      request?.kind === 'attention'
        ? h(Sheet, { title: kindLook(request).kind, role: kindLook(request).role, hint: answerable(request, task) ? 'a answer' : undefined }, h(Text, null, askedFor(request, task)))
        : null,
      h(
        Section,
        { title: 'Runs' },
        runs.length === 0 ? h(Text, tone('dim'), 'None yet.') : null,
        ...runs.map((run) => h(RunRow, { key: run.id, run })),
      ),
      h(TaskUsage, { state, taskId: task.id }),
      h(ArtifactRail, { artifacts: Object.values(state.artifacts).filter((artifact) => artifact.taskId === task.id) }),
    ),
    h(Output, { connection, state, taskId: task.id }),
  );
}

// A task's mode, with its autonomy when it has one: `AFK L2`, `HITL`.
export function modeOf({ mode, autonomy }: Pick<TaskView, 'mode' | 'autonomy'>): string {
  return autonomy ? `${mode} ${autonomy}` : mode;
}

// A run: bright while live, its outcome lit, and dim once it ended.
function RunRow({ run }: { run: RunView }) {
  const used = overall(run.usage);
  const live = run.status !== 'ended';
  const cell = (width: number, text: string, right = false, role: 'fg' | 'dim' | 'ok' = live ? 'fg' : 'dim') =>
    h(Box, { width, flexShrink: 0, justifyContent: right ? 'flex-end' : 'flex-start' }, h(Text, { ...tone(role), wrap: 'truncate' }, text));
  return h(
    Box,
    { gap: 1 },
    cell(4, run.id),
    cell(4, run.mode),
    cell(14, run.stage ?? '—'),
    cell(20, run.model),
    cell(20, runOutcome(run), false, live ? 'ok' : 'dim'),
    cell(8, tokens(tokensOf(used)), true),
    cell(8, dollars(used.cost), true),
  );
}
