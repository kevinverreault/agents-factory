// The answer sheet: the bottom pane of Needs you, for the selected item, and
// of the conversation of a task that needs the operator. A question shows its
// card, whose options the digits pick; any other request, and a root in
// review, lists what each digit does. Ready items take no digits here.
import { createElement as h, useReducer, useRef } from 'react';
import { Box, Text, type Key } from 'ink';
import type { AttentionQueueItem, Permission, PermissionAnswer } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { TaskView } from '../protocol/factory-state.ts';
import type { Command, Reply } from '../protocol/protocol.ts';
import { cardKey, newCard, QuestionCard, type Card } from './question-card.ts';
import { edit } from './text-input.ts';

// What a digit on the sheet does. A choice that `opens` takes the operator
// into the task's conversation once the daemon accepts it; one with `fields`
// first takes what the operator types into them, each under its `prompt`
// and starting at its `value`, and on enter sends what `send` makes of
// them, which `enter` names: nothing while `send` makes nothing of them.
export type Choice =
  | { label: string; command: Command; opens?: boolean }
  | { label: string; fields: Field[]; send: (values: string[]) => Command | null; enter: string };
export type Field = { prompt: string; value: string };

// A choice that takes one typed note, which it sends unless it is blank.
function noted(label: string, prompt: string, enter: string, command: (text: string) => Command): Choice {
  return { label, fields: [{ prompt, value: '' }], send: ([text = '']) => (text.trim() ? command(text.trim()) : null), enter };
}

// A choice that allows the call by rules the operator can widen or narrow
// first: one field per part no rule covers, under that part, holding the
// rule proposed for it. Enter sends the rules left that aren't blank.
function byRules(label: string, enter: string, permission: Permission, answer: (rules: string[]) => PermissionAnswer, taskId: string): Choice {
  const proposed = permission.uncovered ?? [{ part: permission.summary, rule: permission.rule }];
  return {
    label: `${label}: ${proposed.map(({ rule }) => rule).join(', ')}`,
    fields: proposed.map(({ part, rule }) => ({ prompt: part, value: rule })),
    send: (values) => {
      const rules = values.map((rule) => rule.trim()).filter(Boolean);
      return rules.length > 0 ? { type: 'answer', taskId, permission: answer(rules) } : null;
    },
    enter,
  };
}

// The digits' choices on a request other than a question with its card, or
// on a root in review. Kinds whose answers arrive with their own slices (a
// closed PR, a GitHub write) take none yet.
export function choicesFor(item: AttentionQueueItem, task: TaskView | undefined): Choice[] {
  if (item.kind === 'review') {
    const { taskId } = item;
    return [
      noted('Request changes', 'Review comments', 'requests changes', (comments) => ({ type: 'requestChanges', taskId, comments })),
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
      // Requests stored before they named their call allow it for the task as it is.
      const forTask: Choice = item.permission
        ? byRules('Allow for this task', 'allows for this task', item.permission, (rules) => ({ allow: 'task', rules }), taskId)
        : { label: 'Allow for this task: this call', command: { type: 'answer', taskId, permission: { allow: 'task' } } };
      return [
        { label: 'Allow once', command: { type: 'answer', taskId, permission: { allow: 'once' } } },
        forTask,
        noted('Deny with a note', 'Note for the agent', 'denies', (text) => ({ type: 'answer', taskId, permission: { deny: text } })),
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

// The fields the operator is filling in for a choice, as they stand: `at`
// is the one they are typing into, and `enter` what enter does.
export type Form = { fields: Field[]; at: number; enter: string };

// The operator answering an item on its sheet: `key` takes a key while the
// digits are the sheet's. Keys typed in one burst arrive before a re-render,
// so the card the operator is answering on, the fields they are filling in
// for a choice, what a refusal asks back, and the items already answered,
// are kept across renders. `onSend` hears of each answer as it goes out,
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
    form: { for: string; choice: number; values: string[]; at: number } | null;
    confirm: { for: string; reason: string; command: Command } | null;
    sent: Set<string>;
  }>({ card: newCard(), cardFor: null, form: null, confirm: null, sent: new Set() });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  const itemKey = item ? keyOf(item) : null;
  const card = item?.kind === 'attention' && sheet.current.cardFor === itemKey ? sheet.current.card : newCard();
  const form = itemKey !== null && sheet.current.form?.for === itemKey ? sheet.current.form : null;
  const formChoice = form && item ? choicesFor(item, task)[form.choice] : undefined;
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
    if (choice && 'fields' in choice) {
      sheet.current.form = { for: itemKey, choice: index, values: choice.fields.map(({ value }) => value), at: 0 };
      rerender();
    } else if (choice) send(choice.command, choice.opens);
  };
  // A key while the operator fills in the fields a choice takes: up and down
  // (or tab) move between them, enter sends what they make, if anything,
  // and esc sets them aside.
  const fill = (input: string, key: Key) => {
    const command = key.return && form && formChoice && 'fields' in formChoice ? formChoice.send(form.values) : null;
    if (key.escape || !form || !formChoice || !('fields' in formChoice)) sheet.current.form = null;
    else if (key.return) {
      if (command) {
        sheet.current.form = null;
        send(command);
      }
    } else if (key.upArrow) form.at = Math.max(form.at - 1, 0);
    else if (key.downArrow || key.tab) form.at = Math.min(form.at + 1, form.values.length - 1);
    else form.values[form.at] = edit(form.values[form.at]!, input, key) ?? form.values[form.at]!;
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

  return {
    card,
    // The fields being filled in, if any: while they are, every key is theirs.
    form:
      form && formChoice && 'fields' in formChoice
        ? { fields: formChoice.fields.map(({ prompt }, i) => ({ prompt, value: form.values[i]! })), at: form.at, enter: formChoice.enter }
        : null,
    // What a refusal asks back, if anything: while it does, every key is its answer's.
    confirm: confirm?.reason ?? null,
    key: (input: string, key: Key) => (confirm ? goAhead(input, key) : form ? fill(input, key) : answer(input, key)),
  };
}

type Props = {
  item: AttentionQueueItem;
  task: TaskView | undefined;
  // The card the operator is answering the item's question on.
  card: Card;
  // Whether the digits are the sheet's, not the screens'.
  answering: boolean;
  // The fields the operator is filling in for a choice that takes some, if any.
  form: Form | null;
  // What a refusal asks back, if anything.
  confirm?: string | null;
  // Whether esc gives the digits back to the screens: on Needs you, not in a
  // conversation, whose own hint says what its keys do.
  escBack?: boolean;
};

export function AnswerSheet({ item, task, card, answering, form, confirm = null, escBack = true }: Props) {
  // A request about a repository itself has no task: the repository takes the title's place.
  const title = task ? `${task.id} ${task.title}` : item.kind === 'attention' ? item.repo : '';
  const question = item.kind === 'attention' ? item.question : null;
  const hint = answerable(item, task)
    ? confirm !== null
      ? 'y yes · n no'
      : form !== null
      ? `${form.fields.length > 1 ? '↑↓ field · ' : ''}enter ${form.enter} · esc back`
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
    // With more than one field, › marks the one being typed into.
    ...(form?.fields ?? []).map(({ prompt, value }, i) =>
      h(Text, { key: `field-${i}` }, form!.fields.length > 1 ? (i === form!.at ? '› ' : '  ') : '', h(Text, { bold: true }, `${prompt}: `), value),
    ),
    confirm !== null ? h(Text, { color: 'yellow' }, confirm) : null,
    hint ? h(Text, { dimColor: true }, hint) : null,
  );
}
