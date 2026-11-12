// The full-screen conversation view: a run's conversation, replayed from the
// session file and then live, with a side rail of the task's usage and
// artifacts. A HITL run's has a line for the operator's next message, and the
// advance and handoff sheets over it; an AFK run never takes chat, so its view
// only follows it until `c` takes the task over. A task that needs the
// operator shows its request's answer sheet, whose digits answer it here as on
// Needs you.
import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ConversationEvent } from '../executor/executor.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { Reply } from '../protocol/protocol.ts';
import { AdvanceSheet, canAdvance } from './advance-sheet.ts';
import { AnswerSheet, answerable, answeredLine, cardItem, reopens, useAnswering } from './answer-sheet.ts';
import { ArtifactRail } from './artifacts.ts';
import { HandoffSheet } from './handoff-sheet.ts';
import { Event, SystemLine } from './output.ts';
import { answersText, cardKey, newCard, QuestionCard, type Card } from './question-card.ts';
import { fixed, usePager, useRows } from './screen.ts';
import { modeOf } from './task-detail.ts';
import { GLYPH, joined, Keys, Rule, Section, stateLook, tone, type Hint } from './theme.ts';
import { edit } from './text-input.ts';
import { TaskUsage, UsageStrip } from './usage.ts';

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
  // The cards the operator answered here, each with how many events came
  // before it, so its answer shows where it was given: the session file
  // holds the agent's question, but not the operator's answer as a message.
  const [answered, setAnswered] = useState<{ id: string; at: number; text: string }[]>([]);
  // Numbers the answers from the answer sheet, which have no question of their own to name them.
  const sheetAnswers = useRef(0);
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
  const height = useRows();
  const pager = usePager();

  useEffect(() => {
    if (!runId) return;
    setEvents([]);
    setAnswered([]);
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
  // The task's open request, while it needs the operator, or else its HITL
  // run's permission card: when its sheet takes digits, every key but ctrl+b
  // is the sheet's.
  const request =
    state.attentionQueue.find((item) => item.kind === 'attention' && item.taskId === taskId) ??
    (live && run.permission && task ? cardItem(task, run.permission) : undefined);
  // An answer the daemon took shows in the conversation, as a card's does.
  const answers = useAnswering(connection, request, task, {
    onReply: ({ reply, answer }) => {
      tell(reply);
      if (reply.ok) setAnswered((lines) => [...lines, { id: `request-${(sheetAnswers.current += 1)}`, at: events.length, text: answeredLine(answer) }]);
    },
  });
  const answering = answerable(request, task);
  // A live AFK task is talked to only once taken over, which `c` does from
  // here too, unless the answer sheet is taking what the operator types.
  const canTakeOver =
    task?.mode === 'AFK' && ['queued', 'running', 'waiting'].includes(task.state) && answers.form === null && answers.confirm === null;
  const takeOver = () => void connection.send({ type: 'takeOver', taskId }).then(tell);

  // Paging through the conversation, whatever else takes the keys: a sheet over it too.
  useInput((_, key) => {
    if (key.pageUp) pager.up();
    if (key.pageDown) pager.down();
  });
  useInput((input, key) => {
    const typed = typing.current;
    if (key.ctrl && input === 'b') return onLeave();
    if (key.pageUp || key.pageDown) return;
    if (canTakeOver && input === 'c') return takeOver();
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
      const questionId = question!.id;
      const line = { id: questionId, at: events.length, text: answeredLine(answersText(onCard.answers)) };
      setAnswered((lines) => [...lines.filter(({ id }) => id !== questionId), line]);
      void connection.send({ type: 'answerQuestion', taskId, questionId, answers: onCard.answers }).then((reply) => {
        tell(reply);
        if (!reply.ok) setAnswered((lines) => lines.filter(({ id }) => id !== questionId));
        // A refused answer leaves the card up, so the operator sees what is still open.
        if (!reply.ok && typed.answered === questionId) Object.assign(typed, { answered: null, card: newCard() });
        rerender();
      });
      Object.assign(typed, { answered: questionId, draft: '' });
    } else if (onCard.kind === 'card') {
      typed.card = onCard.card;
      if (onCard.clearDraft) typed.draft = '';
    } else if (key.return && !live && reopens(task)) {
      // Parked while open: it reopens first, then takes the message, if any.
      const text = typed.draft.trim() ? typed.draft : null;
      void connection.send({ type: 'open', taskId }).then((reply) => {
        tell(reply);
        if (reply.ok && text) void connection.send({ type: 'sendMessage', taskId, text }).then(tell);
        else if (!reply.ok && text && !typing.current.draft) Object.assign(typing.current, { draft: text });
        rerender();
      });
      typed.draft = '';
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
  const keys: Hint[] = answering
    ? [['digits', 'answer'], ...(canTakeOver ? [['c', 'take over'] as Hint] : [])]
    : !takesChat
      ? [['', `AFK runs take no chat${canTakeOver ? ': c takes it over to talk to it' : ''}`]]
      : question
        ? [['esc', 'interrupt']]
        : midTurn
          ? [['enter', 'queue'], ['esc', 'interrupt']]
          : !live && reopens(task)
            ? [['enter', 'reopens and sends']]
            : [['enter', 'send']];
  const chat = takesChat && !answering;
  const scroll: Hint[] = pager.overflows ? [['pgup/pgdn', `scroll${pager.scrolledBack ? ' (newer below)' : ''}`]] : [];
  const hint: Hint[] = [...keys, ...(canAdvance(task) ? [['ctrl+n', 'advance'] as Hint] : []), ...(chat ? [['/handoff', 'hand off'] as Hint] : []), ['ctrl+b', 'back'], ...scroll];
  const label = task?.label ?? '';
  // The answers given before event `at`, or after the last one.
  const answeredAt = (at: number) =>
    answered.flatMap((line) => (Math.min(line.at, events.length) === at ? [h(Text, { key: `answered-${line.id}`, ...tone('ok') }, line.text)] : []));
  const what = joined([task ? modeOf(task) : null, task?.stage, run?.model]);

  return h(
    Box,
    { flexDirection: 'column', height },
    // On a full screen only the events give way: squeezed, wrapped text
    // would draw its lines over the next ones.
    h(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
      h(Text, { ...tone('accent'), wrap: 'truncate' }, `${GLYPH.conversation} ${taskId} ${task?.title ?? ''}`),
      h(
        Text,
        { ...tone('dim'), wrap: 'truncate' },
        what ? `${what} ${GLYPH.between} ` : '',
        h(Text, tone(stateLook(label).role), label),
        // Before the branch, which a narrow screen cuts first.
        midTurn ? h(Text, tone('ok'), ` ${GLYPH.between} agent working…`) : null,
        task?.branch ? ` ${GLYPH.between} ${task.branch}` : '',
      ),
      // The escape hatch: the same session in the operator's own terminal.
      task?.sessionId
        ? h(Text, { ...tone('dim'), wrap: 'truncate' }, `claude --resume ${task.sessionId}`, task.worktree ? ` (in ${task.worktree})` : '')
        : null,
    ),
    h(
      Box,
      // Sized to the screen, it takes only the room left, to give the
      // handoff sheet all it needs before that sheet gives way.
      { flexGrow: 1, flexBasis: height === undefined ? undefined : 0, gap: 1 },
      // The latest events stay in view, older ones scrolling off the top,
      // until pgup pages back to them.
      h(
        Section,
        { title: 'Conversation', flexGrow: 1, flexShrink: 1, flexBasis: 0 },
        pager.view(
          ...events.flatMap((event, i) => [...answeredAt(i), h(Event, { key: event.id, event })]),
          ...answeredAt(events.length),
          ...(run?.queued ?? []).map((text, i) => h(SystemLine, { key: `queued-${i}`, text: `queued ${text}` })),
        ),
      ),
      // The rail: the task's usage and artifacts, each in its section.
      h(
        Box,
        { flexDirection: 'column', width: RAIL_WIDTH, flexShrink: 0, overflow: 'hidden' },
        h(TaskUsage, { state, taskId }),
        h(ArtifactRail, { artifacts: Object.values(state.artifacts).filter((artifact) => artifact.taskId === taskId) }),
      ),
    ),
    // Of what is below the conversation, only the handoff sheet gives way,
    // once the conversation has none left to give.
    h(
      Box,
      { flexDirection: 'column', flexShrink: 1, overflow: 'hidden' },
      fixed(
        question ? h(QuestionCard, { key: 'question', question, card }) : null,
        live && run.proposal?.kind === 'advance'
          ? h(Text, { key: 'advance', ...tone('warn') }, `${GLYPH.conversation} The agent proposes advancing: ${run.proposal.reason} `, h(Text, { bold: true }, 'ctrl+n'), ' review')
          : null,
        live && run.proposal?.kind === 'handoff' && !sheet
          ? h(Text, { key: 'handoff', ...tone('warn') }, `${GLYPH.conversation} The agent proposes handing off: ${run.proposal.reason} `, h(Text, { bold: true }, 'ctrl+h'), ' or ', h(Text, { bold: true }, '/handoff'), ' review')
          : null,
      ),
      sheet ? h(HandoffSheet, { connection, task: { ...task!, handoff: sheet }, run }) : null,
      fixed(
        advancing && canAdvance(task)
          ? h(AdvanceSheet, { key: 'advance', connection, task, onAdvanced: () => setAdvancing(false), onCancel: () => setAdvancing(false) })
          : null,
        request ? h(AnswerSheet, { key: 'request', item: request, task, card: answers.card, answering, form: answers.form, confirm: answers.confirm, escBack: false }) : null,
        live && (run.turn === 'operator' || question || run.permission) ? h(Text, { key: 'waiting', ...tone('warn') }, 'The agent is waiting on you.') : null,
        refusal ? h(Text, { key: 'refusal', ...tone('bad') }, refusal) : null,
        chat ? h(Text, { key: 'chat' }, h(Text, tone('ok'), `${GLYPH.operator} `), `${draft}${GLYPH.caret}`) : null,
        h(Rule, { key: 'strip-rule' }),
        h(UsageStrip, { key: 'strip', state }),
        h(Rule, { key: 'footer-rule' }),
        h(Keys, { key: 'keys', keys: hint }),
      ),
    ),
  );
}

// Its content 40 columns wide, inside its sections' borders and padding.
const RAIL_WIDTH = 44;

