// A task's output, as the pane under the task tree and the task's detail show
// it: its live run's, or else its last run's, followed without opening the
// conversation, so the run still waits for the operator.
import { createElement as h, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import { runsOf } from './runs.ts';
import { fixed } from './screen.ts';
import { GLYPH, Heading, tone } from './theme.ts';

// With `lines`, a glance: that many of the latest events, a row each. Without
// it, the whole: every event in full, giving way on a short screen so the
// latest stay in view as older ones scroll off the top.
export function Output({ connection, state, taskId, lines }: { connection: FactoryConnection; state: FactoryState; taskId: string; lines?: number }) {
  const runId = state.tasks[taskId]?.liveRunId ?? runsOf(state, taskId).at(-1)?.id ?? null;
  const run = runId ? state.runs[runId] : undefined;
  const whole = lines === undefined;
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!runId) return;
    return connection.follow(runId, (event) => setEvents((events) => (lines === undefined ? [...events, event] : [...events, event].slice(-lines))));
  }, [connection, runId, lines]);

  return h(
    Box,
    // Squeezed below its title, it clips rather than draws over what follows.
    { flexDirection: 'column', flexShrink: whole ? 1 : 0, overflow: 'hidden', marginTop: 1 },
    // Its title: live output while its run is, the last output once it ended.
    fixed(
      h(
        Box,
        { gap: 1 },
        run && run.status !== 'ended' ? h(Text, tone('ok'), GLYPH.live) : null,
        h(Heading, { text: `${!run ? 'Output' : run.status === 'ended' ? 'Last output' : 'Live output'} · ${taskId}${run ? ` · ${run.id}` : ''}` }),
      ),
      events.length === 0 ? h(Text, tone('dim'), run ? 'Nothing yet.' : 'No runs yet.') : null,
    ),
    h(
      Box,
      { flexDirection: 'column', flexShrink: 1, justifyContent: 'flex-end', overflow: 'hidden' },
      ...events.map((event) => h(Event, { key: event.id, event, oneLine: !whole })),
    ),
  );
}

// An event whole, as the conversation view and a task's detail show it, or
// `oneLine` as the pane under the task tree glances at it.
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
