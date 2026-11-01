// The full-screen conversation view: a run's conversation, replayed from the
// session file and then live, with a side rail of the task's artifacts. A HITL
// run's has a line for the operator's next message, and the advance and
// handoff sheets over it; an AFK run never takes chat, so its view only
// follows it. A task that needs the operator shows its request's answer
// sheet, whose digits answer it here as on Needs you.
import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { ArtifactView, FactoryState } from '../protocol/factory-state.ts';
import { issueRef } from '../artifacts/capture.ts';
import type { Reply } from '../protocol/protocol.ts';
import { AdvanceSheet, canAdvance } from './advance-sheet.ts';
import { AnswerSheet, answerable, useAnswering } from './answer-sheet.ts';
import { HandoffSheet } from './handoff-sheet.ts';
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
  const [advancing, setAdvancing] = useState(false);
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

  const takesChat = (run?.mode ?? task?.mode) !== 'AFK';
  const live = takesChat && run?.status === 'active';
  const midTurn = live && run.turn === 'agent';
  // The open card, until the operator has answered it.
  const question = live && run.question && run.question.id !== typing.current.answered ? run.question : null;
  // A card answers its own question: a new question starts a new card.
  const card = question && typing.current.cardFor === question.id ? typing.current.card : newCard();
  const tell = (reply: Reply) => setRefusal(reply.ok ? null : reply.reason);
  // The handoff sheet opens once the daemon has opened the task's handoff.
  const handOff = () => void connection.send({ type: 'openHandoff', taskId }).then(tell);
  const sheet = takesChat && task?.handoff ? task.handoff : null;
  // The task's open request, while it needs the operator: when its sheet
  // takes digits, every key but ctrl+b is the sheet's.
  const request = state.attentionQueue.find((item) => item.kind === 'attention' && item.taskId === taskId);
  const answers = useAnswering(connection, request, task, { onReply: ({ reply }) => tell(reply) });
  const answering = answerable(request, task);

  useInput((input, key) => {
    const typed = typing.current;
    if (key.ctrl && input === 'b') return onLeave();
    if (answering) return answers.key(input, key);
    if (!takesChat) return;
    // At any moment: mid-turn and over an open card too.
    if (key.ctrl && input === 'h') return handOff();
    if (key.return && typed.draft.trim() === '/handoff') {
      typed.draft = '';
      rerender();
      return handOff();
    }
    if (key.ctrl && input === 'n') {
      if (canAdvance(task)) setAdvancing(true);
      return;
    }
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
  }, { isActive: !advancing && !sheet });
  const { draft } = typing.current;
  const keys = answering
    ? 'digits answer'
    : !takesChat
      ? 'AFK runs take no chat: take it over to talk to it'
      : question
        ? 'esc interrupt'
        : midTurn
          ? 'enter queue · esc interrupt'
          : 'enter send';
  const chat = takesChat && !answering;
  const hint = `${keys}${canAdvance(task) ? ' · ctrl+n advance' : ''}${chat ? ' · /handoff hand off' : ''} · ctrl+b back`;

  return h(
    Box,
    { flexDirection: 'column', height: (stdout as NodeJS.WriteStream).rows || undefined },
    h(Box, { gap: 2 }, h(Text, { bold: true }, taskId), h(Text, { wrap: 'truncate' }, task?.title ?? '')),
    h(Text, { dimColor: true }, [task?.branch, task?.stage, run?.model, task?.label].filter(Boolean).join(' · ')),
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
    live && run.proposal?.kind === 'advance'
      ? h(Text, { color: 'yellow' }, `◇ The agent proposes advancing: ${run.proposal.reason} `, h(Text, { bold: true }, 'ctrl+n'), ' review')
      : null,
    live && run.proposal?.kind === 'handoff' && !sheet
      ? h(Text, { color: 'yellow' }, `◇ The agent proposes handing off: ${run.proposal.reason} `, h(Text, { bold: true }, 'ctrl+h'), ' or ', h(Text, { bold: true }, '/handoff'), ' review')
      : null,
    sheet ? h(HandoffSheet, { connection, task: { ...task!, handoff: sheet }, run }) : null,
    advancing && canAdvance(task)
      ? h(AdvanceSheet, { connection, task, onAdvanced: () => setAdvancing(false), onCancel: () => setAdvancing(false) })
      : null,
    request ? h(AnswerSheet, { item: request, task, card: answers.card, answering, form: answers.form, confirm: answers.confirm, escBack: false }) : null,
    live && (run.turn === 'operator' || question) ? h(Text, { color: 'yellow' }, 'The agent is waiting on you.') : null,
    refusal ? h(Text, { color: 'red' }, refusal) : null,
    chat ? h(Text, null, `› ${draft}▏`) : null,
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
  return artifact.kind === 'file' ? artifact.path : issueRef(artifact.url);
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
