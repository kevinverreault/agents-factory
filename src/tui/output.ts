// A task's output, as the pane under the task tree and the task's detail show
// it: its live run's, or else its last run's, followed without opening the
// conversation, so the run still waits for the operator.
import { createElement as h, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import { runsOf } from './runs.ts';

// `lines` is how many of the latest events it shows.
export function Output({ connection, state, taskId, lines }: { connection: FactoryConnection; state: FactoryState; taskId: string; lines: number }) {
  const runId = state.tasks[taskId]?.liveRunId ?? runsOf(state, taskId).at(-1)?.id ?? null;
  const run = runId ? state.runs[runId] : undefined;
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!runId) return;
    return connection.follow(runId, (event) => setEvents((events) => [...events, event].slice(-lines)));
  }, [connection, runId, lines]);

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { bold: true }, 'Output', h(Text, { bold: false, dimColor: true }, run ? ` · ${taskId} · ${run.id} ${run.status === 'ended' ? 'ended' : 'live'}` : ` · ${taskId}`)),
    events.length === 0 ? h(Text, { dimColor: true }, run ? 'Nothing yet.' : 'No runs yet.') : null,
    ...events.map((event) => h(Event, { key: event.id, event, oneLine: true })),
  );
}

// An event as the conversation view shows it, or `oneLine` as the output
// shows it: a glance, the conversation view having the whole.
export function Event({ event, oneLine = false }: { event: ConversationEvent; oneLine?: boolean }) {
  if (event.type === 'toolUse') {
    return h(Box, { gap: 1, flexShrink: 0 }, h(Text, { color: 'cyan' }, `  ● ${event.tool}`), h(Text, { dimColor: true, wrap: 'truncate' }, oneLine ? flat(event.summary) : event.summary));
  }
  const operator = event.from === 'operator';
  return h(
    Box,
    { gap: 1, flexShrink: 0 },
    h(Box, { width: 6, flexShrink: 0 }, h(Text, { bold: true, color: operator ? 'green' : 'magenta' }, operator ? 'you' : 'agent')),
    oneLine ? h(Text, { wrap: 'truncate' }, flat(event.text)) : h(Text, null, event.text),
  );
}

// Text on one row: truncating cuts each of its lines, so a message's
// paragraphs would each take a row and push the screen past the terminal.
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
