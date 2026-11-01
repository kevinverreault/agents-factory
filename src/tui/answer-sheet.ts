// The answer sheet: the bottom pane of Needs you, for the selected item, and
// of the conversation of a task that needs the operator. A question shows its
// card, whose options the digits pick; any other request lists what each
// digit does. Ready and review items take no digits here.
import { createElement as h, useReducer, useRef } from 'react';
import { Box, Text, type Key } from 'ink';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { TaskView } from '../protocol/factory-state.ts';
import type { Command, Reply } from '../protocol/protocol.ts';
import { cardKey, newCard, QuestionCard, type Card } from './question-card.ts';
import { edit } from './text-input.ts';

// What a digit on the sheet does. A choice that `opens` takes the operator
// into the task's conversation once the daemon accepts it; one with a `note`
// first takes the operator's typed note, and sends what it makes of it.
export type Choice = { label: string; command: Command; opens?: boolean } | { label: string; note: (text: string) => Command };

// The digits' choices on a request other than a question with its card.
// Kinds whose answers arrive with their own slices (a closed PR, a GitHub
// write) take none yet.
export function choicesFor(item: AttentionQueueItem, task: TaskView | undefined): Choice[] {
  if (item.kind !== 'attention' || item.taskId === null || item.question) return [];
  const { taskId } = item;
  const answer: Command = { type: 'answer', taskId };
  switch (item.attention) {
    case 'failure': {
      const takeOver: Choice = { label: 'Take over', command: { type: 'takeOver', taskId }, opens: true };
      return [{ label: 'Retry', command: answer }, ...(task?.mode === 'AFK' ? [takeOver] : [])];
    }
    case 'permission': {
      const allow = (allow: 'once' | 'task'): Command => ({ type: 'answer', taskId, permission: { allow } });
      return [
        { label: 'Allow once', command: allow('once') },
        { label: `Allow for this task: ${item.permission?.rule ?? 'this call'}`, command: allow('task') },
        { label: 'Deny with a note', note: (text) => ({ type: 'answer', taskId, permission: { deny: text } }) },
      ];
    }
    case 'stage-blocked':
      return [{ label: 'Dismiss', command: answer }];
    default:
      return [];
  }
}

// Whether the digits answer the item.
export function answerable(item: AttentionQueueItem | undefined, task: TaskView | undefined): boolean {
  return !!item && item.kind === 'attention' && item.taskId !== null && (!!item.question || choicesFor(item, task).length > 0);
}

// What the operator is asked for: the attention request, or else the task's
// own label (Ready for you, In review).
export function waitingFor(item: AttentionQueueItem, task: TaskView | undefined): string {
  if (item.kind === 'attention') return item.reason ? `${item.attention}: ${item.reason}` : item.attention;
  return task?.label ?? '';
}

// What `onReply` hears of a sent answer: the daemon's reply, the task it
// answered for, and whether its choice opens that task's conversation.
export type Answered = { reply: Reply; taskId: string; opens: boolean };

// The operator answering an item on its sheet: `key` takes a key while the
// digits are the sheet's. Keys typed in one burst arrive before a re-render,
// so the card the operator is answering on, the note they are typing for a
// choice, and the requests already answered, are kept across renders.
// `onSend` hears of each answer as it goes out, `onReply` once it is back.
export function useAnswering(
  connection: FactoryConnection,
  item: AttentionQueueItem | undefined,
  task: TaskView | undefined,
  { onSend, onReply }: { onSend?(): void; onReply(answered: Answered): void },
) {
  const sheet = useRef<{
    card: Card;
    cardFor: string | null;
    note: { for: string; choice: number; draft: string } | null;
    sent: Set<string>;
  }>({ card: newCard(), cardFor: null, note: null, sent: new Set() });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  const card = item?.kind === 'attention' && sheet.current.cardFor === item.requestId ? sheet.current.card : newCard();
  const note = item?.kind === 'attention' && sheet.current.note?.for === item.requestId ? sheet.current.note : null;

  const send = (command: Command, opens = false) => {
    if (item?.kind !== 'attention' || !item.taskId) return;
    const { requestId, taskId } = item;
    sheet.current.sent.add(requestId);
    onSend?.();
    void connection.send(command).then((reply) => {
      if (!reply.ok) {
        sheet.current.sent.delete(requestId);
        if (sheet.current.cardFor === requestId) sheet.current.card = newCard();
      }
      onReply({ reply, taskId, opens });
      rerender();
    });
  };
  // A digit on the item's sheet: an option of its question's card (toggled
  // on a multi-select, which enter confirms), or a choice.
  const answer = (input: string, key: Key) => {
    if (item?.kind !== 'attention' || !item.taskId || sheet.current.sent.has(item.requestId)) return;
    if (item.question) {
      if (sheet.current.cardFor !== item.requestId) Object.assign(sheet.current, { card: newCard(), cardFor: item.requestId });
      const onCard = cardKey(item.question, sheet.current.card, '', input, key);
      if (onCard.kind === 'card') sheet.current.card = onCard.card;
      if (onCard.kind === 'answered') send({ type: 'answer', taskId: item.taskId, answers: onCard.answers });
      rerender();
      return;
    }
    const index = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    const choice = choicesFor(item, task)[index];
    if (choice && 'note' in choice) {
      sheet.current.note = { for: item.requestId, choice: index, draft: '' };
      rerender();
    } else if (choice) send(choice.command, choice.opens);
  };
  // A key while the operator types the note a choice takes: enter sends it,
  // unless it is empty, and esc sets it aside.
  const takeNote = (input: string, key: Key) => {
    const choice = note && item && choicesFor(item, task)[note.choice];
    if (key.escape || !choice || !('note' in choice)) sheet.current.note = null;
    else if (key.return && note.draft.trim()) {
      sheet.current.note = null;
      send(choice.note(note.draft.trim()));
    } else note.draft = edit(note.draft, input, key) ?? note.draft;
    rerender();
  };

  return {
    card,
    // The note being typed, if any: while it is, every key is the note's.
    note: note?.draft ?? null,
    key: (input: string, key: Key) => (note ? takeNote(input, key) : answer(input, key)),
  };
}

type Props = {
  item: AttentionQueueItem;
  task: TaskView | undefined;
  // The card the operator is answering the item's question on.
  card: Card;
  // Whether the digits are the sheet's, not the screens'.
  answering: boolean;
  // The note the operator is typing for a choice that takes one, if any.
  note: string | null;
  // Whether esc gives the digits back to the screens: on Needs you, not in a
  // conversation, whose own hint says what its keys do.
  escBack?: boolean;
};

export function AnswerSheet({ item, task, card, answering, note, escBack = true }: Props) {
  // A request about a repository itself has no task: the repository takes the title's place.
  const title = task ? `${task.id} ${task.title}` : item.kind === 'attention' ? item.repo : '';
  const question = item.kind === 'attention' ? item.question : null;
  const hint = answerable(item, task)
    ? note !== null
      ? 'enter denies · esc back'
      : answering
      ? escBack ? 'digits answer · esc back' : null
      : 'a answer'
    : item.kind === 'ready' && task?.liveRunId
      ? 'enter opens the conversation'
      : item.kind === 'attention' && item.attention === 'repo-missing'
        ? 'Put the clone back, or run `agents-factory repo move <new-path>`.'
        : null;
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { dimColor: true, wrap: 'truncate' }, `── ${title} ──`),
    question ? h(QuestionCard, { question, card, ownWords: false }) : h(Text, null, waitingFor(item, task)),
    ...choicesFor(item, task).map((choice, i) =>
      h(Box, { key: choice.label, gap: 1 }, h(Text, { bold: true, color: 'cyan' }, String(i + 1)), h(Text, null, choice.label)),
    ),
    note !== null ? h(Text, null, h(Text, { bold: true }, 'Note for the agent: '), note) : null,
    hint ? h(Text, { dimColor: true }, hint) : null,
  );
}
