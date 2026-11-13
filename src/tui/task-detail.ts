// A task's detail, drilled into from a screen with `enter`: its title, what
// it is on one line, its open request, a spec task's tickets, its runs, its
// usage and artifacts, and its output whole. `condensed`, as the condensed
// view's detail pane shows it, leaves out the usage and artifacts, so the
// output has their rows.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, RunView, TaskView, TicketSetView, TicketView } from '../protocol/factory-state.ts';
import { overall, tokensOf } from '../usage/usage.ts';
import { answerable, askedFor } from './answer-sheet.ts';
import { ArtifactRail } from './artifacts.ts';
import { Output } from './output.ts';
import { runOutcome, runsOf } from './runs.ts';
import { fixed } from './screen.ts';
import { GLYPH, joined, kindLook, Section, Sheet, stateLook, tone } from './theme.ts';
import { dollars, tokens, TaskUsage } from './usage.ts';

export function TaskDetail({
  connection,
  state,
  task,
  condensed = false,
}: {
  connection: FactoryConnection;
  state: FactoryState;
  task: TaskView;
  condensed?: boolean;
}) {
  const runs = runsOf(state, task.id);
  // The model its live run is on, or its last run was.
  const model = (task.liveRunId ? state.runs[task.liveRunId] : runs.at(-1))?.model;
  const parent = task.parent ? state.tasks[task.parent] : undefined;
  const parentage = task.parent ? `parent ${task.parent}${parent ? ` ${parent.title}` : ''}${task.child ? (task.child.awaited ? ' (awaited)' : ' (fire-and-forget)') : ''}` : null;
  // What it runs as, then its state, then what it belongs to. Where it is,
  // its stage and branch, has a line of its own.
  const runsAs = joined([modeOf(task), model, task.tier]);
  const belongsTo = joined([task.groups.join(', '), parentage]);
  const whereItIs = joined([task.stage, task.branch]);
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
        runsAs ? `${runsAs} ${GLYPH.between} ` : '',
        h(Text, tone(stateLook(task.label).role), task.label),
        belongsTo ? ` ${GLYPH.between} ${belongsTo}` : '',
      ),
      whereItIs ? h(Text, { ...tone('dim'), wrap: 'truncate' }, whereItIs) : null,
      task.progress ? h(Text, { ...tone('dim'), wrap: 'truncate' }, task.progress) : null,
      request?.kind === 'attention'
        ? h(Sheet, { title: kindLook(request).kind, role: kindLook(request).role, hint: answerable(request, task) ? 'a answer' : undefined }, h(Text, null, askedFor(request, task)))
        : null,
      task.ticketSet ? h(Tickets, { state, ticketSet: task.ticketSet }) : null,
      h(
        Section,
        { title: 'Runs' },
        runs.length === 0 ? h(Text, tone('dim'), 'None yet.') : null,
        ...runs.map((run) => h(RunRow, { key: run.id, run })),
      ),
      condensed ? null : h(TaskUsage, { state, taskId: task.id }),
      condensed ? null : h(ArtifactRail, { artifacts: Object.values(state.artifacts).filter((artifact) => artifact.taskId === task.id) }),
    ),
    h(Output, { connection, state, taskId: task.id }),
  );
}

// A task's mode, with its autonomy when it has one: `AFK L2`, `HITL`.
export function modeOf({ mode, autonomy }: Pick<TaskView, 'mode' | 'autonomy'>): string {
  return autonomy ? `${mode} ${autonomy}` : mode;
}

// The width of a ticket's title in a spec task's detail.
const TICKET_TITLE_WIDTH = 30;

// A spec task's tickets (ADR 0013), each a row: its ref, its title and where
// it stands, and why the factory last couldn't read or launch them.
function Tickets({ state, ticketSet }: { state: FactoryState; ticketSet: TicketSetView }) {
  const refWidth = Math.max(0, ...ticketSet.tickets.map((ticket) => ticket.ref.length));
  return h(
    Section,
    { title: ticketSet.spec ? `Tickets of ${ticketSet.spec}` : 'Tickets' },
    ticketSet.problem ? h(Text, { ...tone('warn'), wrap: 'truncate' }, ticketSet.problem) : null,
    ticketSet.tickets.length === 0 ? h(Text, tone('dim'), 'None yet.') : null,
    ...ticketSet.tickets.map((ticket) =>
      h(
        Box,
        { key: ticket.ref, gap: 1 },
        h(Box, { width: refWidth, flexShrink: 0 }, h(Text, tone('dim'), ticket.ref)),
        h(Box, { width: TICKET_TITLE_WIDTH, flexShrink: 0 }, h(Text, { ...tone('fg'), wrap: 'truncate' }, ticket.title ?? '')),
        h(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, h(Text, { ...tone(ticket.state === 'launched' ? 'fg' : 'dim'), wrap: 'truncate' }, standing(state, ticket))),
      ),
    ),
  );
}

// Where a ticket stands: its ticket task and that task's state while
// launched, or what it waits on, or why it won't be launched.
function standing(state: FactoryState, ticket: TicketView): string {
  switch (ticket.state) {
    case 'launched':
      return `${ticket.taskId} ${state.tasks[ticket.taskId]?.label ?? ''}`.trim();
    case 'launching':
      return 'launching';
    case 'waiting':
      return ticket.blockers.length ? `waiting on ${ticket.blockers.join(', ')}` : 'waiting';
    case 'held-back':
      return 'held back';
    case 'skipped':
      return 'skipped';
    case 'merged':
      return ticket.taskId ? `merged (${ticket.taskId})` : 'merged';
  }
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
