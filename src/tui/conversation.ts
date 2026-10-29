// The full-screen conversation view: a HITL run's conversation, replayed from
// the session file and then live, with a line for the operator's next message
// and a side rail of the task's artifacts.
import { createElement as h, useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { ArtifactView, FactoryState } from '../protocol/factory-state.ts';
import { edit } from './text-input.ts';

type Props = {
  connection: FactoryConnection;
  state: FactoryState;
  taskId: string;
  onLeave(): void;
};

export function Conversation({ connection, state, taskId, onLeave }: Props) {
  const task = state.tasks[taskId];
  // The live run, or else the task's last one, whose session holds it all.
  const runId = task?.liveRunId ?? Object.values(state.runs).findLast((run) => run.taskId === taskId)?.id ?? null;
  const run = runId ? state.runs[runId] : undefined;
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const { stdout } = useStdout();

  useEffect(() => {
    if (!runId) return;
    setEvents([]);
    return connection.converse(runId, (event) => setEvents((events) => [...events, event]));
  }, [connection, runId]);

  useInput((input, key) => {
    if (key.ctrl && input === 'b') return onLeave();
    if (key.return) {
      if (!draft.trim()) return;
      void connection.send({ type: 'sendMessage', taskId, text: draft }).then((reply) => setRefusal(reply.ok ? null : reply.reason));
      setDraft('');
      return;
    }
    // Keys typed in one burst arrive before a re-render.
    setDraft((draft) => edit(draft, input, key) ?? draft);
  });

  return h(
    Box,
    { flexDirection: 'column', height: (stdout as NodeJS.WriteStream).rows || undefined },
    h(Box, { gap: 2 }, h(Text, { bold: true }, taskId), h(Text, { wrap: 'truncate' }, task?.title ?? '')),
    h(Text, { dimColor: true }, [task?.branch, run?.model, task?.label].filter(Boolean).join(' · ')),
    h(
      Box,
      { flexGrow: 1, marginY: 1, gap: 2 },
      // The latest events stay in view; older ones scroll off the top.
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end', overflow: 'hidden' },
        ...events.map((event) => h(Event, { key: event.id, event })),
      ),
      h(ArtifactRail, { artifacts: Object.values(state.artifacts).filter((artifact) => artifact.taskId === taskId) }),
    ),
    refusal ? h(Text, { color: 'red' }, refusal) : null,
    h(Text, null, `› ${draft}▏`),
    h(Text, { dimColor: true }, 'enter send · ctrl+b back'),
  );
}

const RAIL_WIDTH = 40;

// What the task produced so far, live: captured from the run's tool calls.
// The newest come first, so a full rail cuts off the oldest.
function ArtifactRail({ artifacts }: { artifacts: ArtifactView[] }) {
  return h(
    Box,
    { flexDirection: 'column', width: RAIL_WIDTH, flexShrink: 0, overflow: 'hidden' },
    h(Text, { bold: true }, 'Artifacts'),
    artifacts.length === 0 ? h(Text, { dimColor: true }, 'None yet.') : null,
    ...artifacts.toReversed().map((artifact) =>
      h(
        Box,
        { key: artifact.id, gap: 1 },
        h(Box, { width: 11, flexShrink: 0 }, h(Text, { dimColor: true }, artifactState(artifact))),
        h(Text, { wrap: 'truncate-start' }, artifactName(artifact)),
      ),
    ),
  );
}

function artifactState(artifact: ArtifactView): string {
  if (artifact.kind === 'issue') return 'issue';
  return artifact.committed ? 'committed' : 'uncommitted';
}

// A file by its path in the worktree, an issue as `owner/name#number`.
function artifactName(artifact: ArtifactView): string {
  if (artifact.kind === 'file') return artifact.path;
  const [, owner, name, , number] = new URL(artifact.url).pathname.split('/');
  return `${owner}/${name}#${number}`;
}

function Event({ event }: { event: ConversationEvent }) {
  if (event.type === 'toolUse') {
    return h(Box, { gap: 1, flexShrink: 0 }, h(Text, { color: 'cyan' }, `  ● ${event.tool}`), h(Text, { dimColor: true, wrap: 'truncate' }, event.summary));
  }
  const operator = event.from === 'operator';
  return h(
    Box,
    { gap: 1, flexShrink: 0 },
    h(Box, { width: 6, flexShrink: 0 }, h(Text, { bold: true, color: operator ? 'green' : 'magenta' }, operator ? 'you' : 'agent')),
    h(Text, null, event.text),
  );
}
