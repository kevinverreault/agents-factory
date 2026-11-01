// The answer sheet: the bottom pane of Needs you, for the selected item, and
// of the conversation of a task that needs the operator. A question shows its
// card, whose options the digits pick; any other request, and a root in
// review, lists what each digit does. Ready items take no digits here.
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
// first takes the operator's typed note, under `prompt`, and sends what it
// makes of it on enter, which `enter` names.
export type Choice =
  | { label: string; command: Command; opens?: boolean }
  | { label: string; note: (text: string) => Command; prompt: string; enter: string };

// The digits' choices on a request other than a question with its card, or
// on a root in review. Kinds whose answers arrive with their own slices (a
// closed PR, a GitHub write) take none yet.
export function choicesFor(item: AttentionQueueItem, task: TaskView | undefined): Choice[] {
  if (item.kind === 'review') {
    const { taskId } = item;
    return [
      { label: 'Request changes', note: (comments) => ({ type: 'requestChanges', taskId, comments }), prompt: 'Review comments', enter: 'requests changes' },
      { label: 'Mark done', command: { type: 'markDone', taskId } },
      { label: 'Cancel', command: { type: 'cancel', taskId } },
    ];
  }
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
        { label: 'Deny with a note', note: (text) => ({ type: 'answer', taskId, permission: { deny: text } }), prompt: 'Note for the agent', enter: 'denies' },
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
  if (!item || item.taskId === null) return false;
  return (item.kind === 'attention' && !!item.question) || choicesFor(item, task).length > 0;
}

// What the sheet tells one item from another by.
function keyOf(item: AttentionQueueItem): string {
  return item.kind === 'attention' ? item.requestId : `${item.kind}-${item.taskId}`;
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

// The note the operator is typing for a choice, with what it is for.
export type Note = { draft: string; prompt: string; enter: string };

// The operator answering an item on its sheet: `key` takes a key while the
// digits are the sheet's. Keys typed in one burst arrive before a re-render,
// so the card the operator is answering on, the note they are typing for a
// choice, what a refusal asks back, and the items already answered, are
// kept across renders. `onSend` hears of each answer as it goes out,
// `onReply` once it is back, unless the reply asks whether to go ahead
// anyway: the sheet asks that instead, and y sends what it confirms.
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
    confirm: { for: string; reason: string; command: Command } | null;
    sent: Set<string>;
  }>({ card: newCard(), cardFor: null, note: null, confirm: null, sent: new Set() });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  const itemKey = item ? keyOf(item) : null;
  const card = item?.kind === 'attention' && sheet.current.cardFor === itemKey ? sheet.current.card : newCard();
  const note = itemKey !== null && sheet.current.note?.for === itemKey ? sheet.current.note : null;
  const confirm = itemKey !== null && sheet.current.confirm?.for === itemKey ? sheet.current.confirm : null;

  const send = (command: Command, opens = false) => {
    if (!item?.taskId || itemKey === null) return;
    const { taskId } = item;
    const sentFor = itemKey;
    sheet.current.sent.add(sentFor);
    onSend?.();
    void connection.send(command).then((reply) => {
      if (!reply.ok) {
        sheet.current.sent.delete(sentFor);
        if (sheet.current.cardFor === sentFor) sheet.current.card = newCard();
      }
      if (!reply.ok && reply.confirm) sheet.current.confirm = { for: sentFor, reason: reply.reason, command: reply.confirm };
      else onReply({ reply, taskId, opens });
      rerender();
    });
  };
  // A digit on the item's sheet: an option of its question's card (toggled
  // on a multi-select, which enter confirms), or a choice.
  const answer = (input: string, key: Key) => {
    if (!item?.taskId || itemKey === null || sheet.current.sent.has(itemKey)) return;
    if (item.kind === 'attention' && item.question) {
      if (sheet.current.cardFor !== itemKey) Object.assign(sheet.current, { card: newCard(), cardFor: itemKey });
      const onCard = cardKey(item.question, sheet.current.card, '', input, key);
      if (onCard.kind === 'card') sheet.current.card = onCard.card;
      if (onCard.kind === 'answered') send({ type: 'answer', taskId: item.taskId, answers: onCard.answers });
      rerender();
      return;
    }
    const index = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    const choice = choicesFor(item, task)[index];
    if (choice && 'note' in choice) {
      sheet.current.note = { for: itemKey, choice: index, draft: '' };
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
  // A key while the sheet asks whether to go ahead anyway: y does, n or esc doesn't.
  const goAhead = (input: string, key: Key) => {
    if (input === 'y') {
      sheet.current.confirm = null;
      send(confirm!.command);
    } else if (input === 'n' || key.escape) sheet.current.confirm = null;
    rerender();
  };
  const noteChoice = note && item ? choicesFor(item, task)[note.choice] : undefined;

  return {
    card,
    // The note being typed, if any: while it is, every key is the note's.
    note: note && noteChoice && 'note' in noteChoice ? { draft: note.draft, prompt: noteChoice.prompt, enter: noteChoice.enter } : null,
    // What a refusal asks back, if anything: while it does, every key is its answer's.
    confirm: confirm?.reason ?? null,
    key: (input: string, key: Key) => (confirm ? goAhead(input, key) : note ? takeNote(input, key) : answer(input, key)),
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
  note: Note | null;
  // What a refusal asks back, if anything.
  confirm?: string | null;
  // Whether esc gives the digits back to the screens: on Needs you, not in a
  // conversation, whose own hint says what its keys do.
  escBack?: boolean;
};

export function AnswerSheet({ item, task, card, answering, note, confirm = null, escBack = true }: Props) {
  // A request about a repository itself has no task: the repository takes the title's place.
  const title = task ? `${task.id} ${task.title}` : item.kind === 'attention' ? item.repo : '';
  const question = item.kind === 'attention' ? item.question : null;
  const hint = answerable(item, task)
    ? confirm !== null
      ? 'y yes · n no'
      : note !== null
      ? `enter ${note.enter} · esc back`
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
    note !== null ? h(Text, null, h(Text, { bold: true }, `${note.prompt}: `), note.draft) : null,
    confirm !== null ? h(Text, { color: 'yellow' }, confirm) : null,
    hint ? h(Text, { dimColor: true }, hint) : null,
  );
}
