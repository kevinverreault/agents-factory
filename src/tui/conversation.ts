// The full-screen conversation view: a HITL run's conversation, replayed from
// the session file and then live, with a line for the operator's next message
// and a side rail of the task's artifacts.
import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { ArtifactView, FactoryState } from '../protocol/factory-state.ts';
import type { Reply } from '../protocol/protocol.ts';
import { cardKey, newCard, QuestionCard, type Card } from './question-card.ts';
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
  const [refusal, setRefusal] = useState<string | null>(null);
  // Keys typed in one burst arrive before a re-render, so what they edit is
  // kept here: the draft, and the card for the question it answers.
  const typing = useRef<{ draft: string; card: Card; cardFor: string | null; answered: string | null }>({
    draft: '',
    card: newCard(),
    cardFor: null,
    answered: null,
  });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  const { stdout } = useStdout();

  useEffect(() => {
    if (!runId) return;
    setEvents([]);
    return connection.converse(runId, (event) => setEvents((events) => [...events, event]));
  }, [connection, runId]);

  const live = run?.status === 'active';
  const midTurn = live && run.turn === 'agent';
  // The open card, until the operator has answered it.
  const question = live && run.question && run.question.id !== typing.current.answered ? run.question : null;
  // A card answers its own question: a new question starts a new card.
  const card = question && typing.current.cardFor === question.id ? typing.current.card : newCard();
  const tell = (reply: Reply) => setRefusal(reply.ok ? null : reply.reason);

  useInput((input, key) => {
    const typed = typing.current;
    if (key.ctrl && input === 'b') return onLeave();
    if (key.escape) {
      if (midTurn) void connection.send({ type: 'interrupt', taskId }).then(tell);
      return;
    }
    if (question && typed.cardFor !== question.id) Object.assign(typed, { card: newCard(), cardFor: question.id });
    const onCard = question ? cardKey(question, typed.card, typed.draft, input, key) : { kind: 'ignored' as const };
    if (onCard.kind === 'answered') {
      const answered = question!.id;
      void connection.send({ type: 'answerQuestion', taskId, questionId: answered, answers: onCard.answers }).then((reply) => {
        tell(reply);
        // A refused answer leaves the card up, so the operator sees what is still open.
        if (!reply.ok && typed.answered === answered) Object.assign(typed, { answered: null, card: newCard() });
        rerender();
      });
      Object.assign(typed, { answered, draft: '' });
    } else if (onCard.kind === 'card') {
      typed.card = onCard.card;
      if (onCard.clearDraft) typed.draft = '';
    } else if (key.return) {
      if (!typed.draft.trim()) return;
      void connection.send({ type: 'sendMessage', taskId, text: typed.draft }).then(tell);
      typed.draft = '';
    } else {
      typed.draft = edit(typed.draft, input, key) ?? typed.draft;
    }
    rerender();
  });
  const { draft } = typing.current;
  const hint = question ? 'esc interrupt · ctrl+b back' : midTurn ? 'enter queue · esc interrupt · ctrl+b back' : 'enter send · ctrl+b back';

  return h(
    Box,
    { flexDirection: 'column', height: (stdout as NodeJS.WriteStream).rows || undefined },
    h(Box, { gap: 2 }, h(Text, { bold: true }, taskId), h(Text, { wrap: 'truncate' }, task?.title ?? '')),
    h(Text, { dimColor: true }, [task?.branch, run?.model, task?.label].filter(Boolean).join(' · ')),
    // The escape hatch: the same session in the operator's own terminal.
    task?.sessionId
      ? h(Text, { dimColor: true, wrap: 'truncate' }, `claude --resume ${task.sessionId}`, task.worktree ? ` (in ${task.worktree})` : '')
      : null,
    h(
      Box,
      { flexGrow: 1, marginY: 1, gap: 2 },
      // The latest events stay in view; older ones scroll off the top.
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end', overflow: 'hidden' },
        ...events.map((event) => h(Event, { key: event.id, event })),
        ...(run?.queued ?? []).map((text, i) =>
          h(Box, { key: `queued-${i}`, gap: 1, flexShrink: 0 }, h(Box, { width: 6, flexShrink: 0 }, h(Text, { dimColor: true }, 'queued')), h(Text, { dimColor: true }, text)),
        ),
      ),
      h(ArtifactRail, { artifacts: Object.values(state.artifacts).filter((artifact) => artifact.taskId === taskId) }),
    ),
    question ? h(QuestionCard, { question, card }) : null,
    live && (run.turn === 'operator' || question) ? h(Text, { color: 'yellow' }, 'The agent is waiting on you.') : null,
    refusal ? h(Text, { color: 'red' }, refusal) : null,
    h(Text, null, `› ${draft}▏`),
    h(Text, { dimColor: true }, hint),
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
