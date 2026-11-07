// The answer sheet: the bottom pane of Needs you, for the selected item, and
// of the conversation of a task that needs the operator. A question shows its
// card, whose options the digits pick; any other request, and a root in
// review, lists what each digit does. Ready items take no digits here, but
// for a work loop's: its map's frontier tickets, or once it cleared, where
// the task goes next.
import { createElement as h, useReducer, useRef } from 'react';
import { Box, Text, type Key } from 'ink';
import type { AttentionQueueItem, Permission, PermissionAnswer } from '../lifecycle/lifecycle.ts';
import { isWorkLoop } from '../presets/presets.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { TaskView } from '../protocol/factory-state.ts';
import type { Command, Option, Reply } from '../protocol/protocol.ts';
import { ChoosePrompt, chooseKey } from './choose.ts';
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
// One line the operator types into, under its prompt.
export type Field = { prompt: string; value: string };

// A choice that takes one typed note, which it sends unless it is blank.
function noted(label: string, prompt: string, enter: string, command: (text: string) => Command): Choice {
  return { label, fields: [{ prompt, value: '' }], send: ([text = '']) => (text.trim() ? command(text.trim()) : null), enter };
}

// An answer to a permission request that allows by rules: what its choice
// reads, what enter does, and the answer the confirmed rules make.
type ByRules = { label: string; enter: string; answer: (rules: string[]) => PermissionAnswer };
const FOR_THIS_TASK: ByRules = { label: 'Allow for this task', enter: 'allows for this task', answer: (rules) => ({ allow: 'task', rules }) };
// Adds the rules to the operator's permissions file, for every task.
const ALWAYS: ByRules = { label: 'Allow always', enter: 'allows always', answer: (rules) => ({ allow: 'always', rules }) };

// A choice that allows the call by rules the operator can widen or narrow
// first: one field per part no rule covers, under that part, holding the
// rule proposed for it. Enter sends the rules left that aren't blank.
function byRules(taskId: string, permission: Permission, { label, enter, answer }: ByRules): Choice {
  const proposed = permission.proposed ?? [{ part: permission.summary, rule: permission.rule }];
  return {
    label: `${label}: ${proposed.map(({ rule }) => shownRule(rule)).join(', ')}`,
    fields: proposed.map(({ part, rule }) => ({ prompt: part, value: rule })),
    send: (values) => {
      const rules = values.map((rule) => rule.trim()).filter(Boolean);
      return rules.length > 0 ? { type: 'answer', taskId, permission: answer(rules) } : null;
    },
    enter,
  };
}

// A rule as the sheet shows it, on one line: a heredoc's exact rule holds its
// whole script, so its lines are joined by ↵, and a long rule keeps its start
// and its end, where the operator types, around an ellipsis.
function shownRule(rule: string): string {
  const line = rule.replace(/[ \t]*\r?\n[ \t]*/g, ' ↵ ');
  return line.length <= SHOWN_RULE ? line : `${line.slice(0, SHOWN_RULE / 2)} … ${line.slice(-SHOWN_RULE / 2)}`;
}
const SHOWN_RULE = 120;

// The digits' choices on a request other than a question with its card, or
// on a root in review.
export function choicesFor(item: AttentionQueueItem, task: TaskView | undefined): Choice[] {
  if (item.kind === 'ready') return task ? workLoopChoices(task) : [];
  if (item.kind === 'review') {
    const { taskId } = item;
    // An L1 root publishes as the factory's App on the operator's say (ADR
    // 0007): once it has its PR (a regular one where GitHub offers no
    // drafts), a push updates it, which only a run's new work calls for.
    const publish: Choice[] =
      task?.autonomy === 'L1' && !task.publishing && !(task.pr && task.pushed)
        ? [{ label: task.pr ? `Push to ${task.pr.draft ? 'draft ' : ''}PR #${task.pr.number}` : 'Push & open draft PR', command: { type: 'pushAndOpenPr', taskId } }]
        : [];
    return [
      noted('Request changes', 'Review comments', 'requests changes', (comments) => ({ type: 'requestChanges', taskId, comments })),
      { label: 'Mark done', command: { type: 'markDone', taskId } },
      { label: 'Cancel', command: { type: 'cancel', taskId } },
      ...publish,
    ];
  }
  // The Factory recovered report asks only to be read (ADR 0003).
  if (item.kind === 'attention' && item.attention === 'recovery-report') return [{ label: 'Dismiss', command: { type: 'dismiss', requestId: item.requestId } }];
  if (item.kind !== 'attention' || item.taskId === null || item.question) return [];
  const { taskId } = item;
  const answer: Command = { type: 'answer', taskId };
  const takeOver: Choice[] = task?.mode === 'AFK' ? [{ label: 'Take over', command: { type: 'takeOver', taskId }, opens: true }] : [];
  const cancel: Choice = { label: 'Cancel', command: { type: 'cancel', taskId } };
  switch (item.attention) {
    case 'failure': {
      // Only the operator decides what a failure means (ADR 0006): a failed
      // AFK iteration's ticket can be skipped too.
      const ticket = task?.mode === 'AFK' ? task.loop?.ticket : null;
      const skip: Choice[] = ticket ? [{ label: `Skip ${ticket}`, command: { type: 'answer', taskId, skip: true } }] : [];
      return [{ label: 'Retry', command: answer }, ...skip, ...takeOver, cancel];
    }
    case 'permission': {
      // Requests stored before they named their call allow it for the task
      // as it is, and never always: they have no rule to add.
      const byRulesChoices: Choice[] = item.permission
        ? [byRules(taskId, item.permission, FOR_THIS_TASK), byRules(taskId, item.permission, ALWAYS)]
        : [{ label: 'Allow for this task: this call', command: { type: 'answer', taskId, permission: { allow: 'task' } } }];
      return [
        { label: 'Allow once', command: { type: 'answer', taskId, permission: { allow: 'once' } } },
        ...byRulesChoices,
        noted('Deny with a note', 'Note for the agent', 'denies', (text) => ({ type: 'answer', taskId, permission: { deny: text } })),
      ];
    }
    case 'github-write':
      // Answered once the operator fixed what refused the write.
      return [{ label: 'Try again', command: answer }];
    case 'pr-closed-unmerged':
      // The factory never cancels on its own (ADR 0011): the operator chooses.
      return [
        { label: 'Cancel task', command: { type: 'cancel', taskId } },
        { label: 'Reopen PR', command: { type: 'reopenPr', taskId } },
      ];
    case 'stage-blocked':
      // A stalled loop picks again once answered, and a work loop reads its map again.
      if (task?.mode === 'AFK' && task.loop) return [{ label: 'Retry', command: answer }, ...takeOver, cancel];
      // Raised once the map cleared, it is the next stage that couldn't start: nothing is read again.
      return task?.loop && !task.loop.cleared && workLoopAt(task)
        ? [{ label: 'Read the map again', command: answer }, cancel]
        : [{ label: 'Dismiss', command: answer }];
    default:
      return [];
  }
}

// A work loop over a map (wayfinder) Ready for you between its tickets: a
// digit picks a ticket of its frontier into its conversation, 1 the first.
// Once its map has cleared, the operator chooses where the task goes: on to
// the next stage, jumping over it to the one after, or to the end.
function workLoopChoices(task: TaskView): Choice[] {
  const { loop, preset, stage, id: taskId } = task;
  if (!loop || loop.ticket || !preset) return [];
  if (loop.frontier) {
    return loop.frontier.slice(0, 9).map(({ ref, title }) => ({ label: `${ref} ${title}`, command: { type: 'open', taskId, ticket: ref }, opens: true }));
  }
  if (!loop.cleared) return [];
  const at = preset.stages.findIndex(({ id }) => id === stage);
  const [next, after] = preset.stages.slice(at + 1);
  const hitl = (to: typeof next) => to?.mode === 'HITL';
  return [
    ...(hitl(next) ? [{ label: `Continue to ${next!.id}`, command: { type: 'advanceStage' as const, taskId }, opens: true }] : []),
    ...(hitl(next) && hitl(after) ? [{ label: `Jump to ${after!.id}`, command: { type: 'advanceStage' as const, taskId, skip: [next!.id] }, opens: true }] : []),
    { label: `End: put ${taskId} in review`, command: { type: 'advanceStage', taskId, end: true } },
  ];
}

// Whether the task is at a work loop over a map.
function workLoopAt({ preset, stage }: TaskView): boolean {
  return isWorkLoop(preset?.stages.find(({ id }) => id === stage));
}

// A HITL run's permission card, as the sheet's item: answered as a
// permission request is, though it is no attention request.
export function cardItem(task: TaskView, permission: Permission): AttentionQueueItem {
  return {
    kind: 'attention',
    taskId: task.id,
    repo: task.repo,
    requestId: permission.id,
    attention: 'permission',
    holdsRun: true,
    reason: `${permission.tool}: ${permission.summary}`,
    question: null,
    permission,
    recovery: null,
  };
}

// Whether the digits answer the item.
export function answerable(item: AttentionQueueItem | undefined, task: TaskView | undefined): boolean {
  if (!item) return false;
  return (item.kind === 'attention' && !!item.question) || choicesFor(item, task).length > 0;
}

// What the sheet tells one item from another by.
function keyOf(item: AttentionQueueItem): string {
  return item.kind === 'attention' ? item.requestId : `${item.kind}-${item.taskId}`;
}

// What the operator is asked for: the attention request, or else the task's
// own label (Ready for you, In review).
export function waitingFor(item: AttentionQueueItem, task: TaskView | undefined): string {
  if (item.kind === 'attention' && item.attention === 'recovery-report') return item.reason ?? '';
  if (item.kind === 'attention') return item.reason ? `${item.attention}: ${item.reason}` : item.attention;
  if (item.kind === 'ready' && task?.loop?.cleared) return `${task.label}: the map has cleared`;
  return task?.label ?? '';
}

// What `onReply` hears of a sent answer: the daemon's reply, the task it
// answered for (none for a request about the factory or a repository), and
// whether its choice opens that task's conversation.
export type Answered = { reply: Reply; taskId: string | null; opens: boolean };

// What an item's row and sheet are titled by: its task, or else the
// repository a request is about, or the factory itself.
export function titleOf(item: AttentionQueueItem, task: TaskView | undefined, { withId = false } = {}): string {
  if (task) return withId ? `${task.id} ${task.title}` : task.title;
  return item.kind === 'attention' ? (item.repo ?? 'Factory recovered') : '';
}

// What a refusal asks back: whether to go ahead anyway (no `options`), or
// which of its options to go ahead with.
export type Ask = { reason: string; options: string[] | null };

// The fields the operator is filling in for a choice, as they stand: `at`
// is the one they are typing into, and `enter` what enter does.
export type Form = { fields: Field[]; at: number; enter: string };

// The operator answering an item on its sheet: `key` takes a key while the
// digits are the sheet's. Keys typed in one burst arrive before a re-render,
// so the card the operator is answering on, the fields they are filling in
// for a choice, what a refusal asks back, and the items already answered,
// are kept across renders. `onSend` hears of each answer as it goes out,
// `onReply` once it is back, unless the reply asks whether to go ahead
// anyway, or which way to: the sheet asks that instead, and y sends what it
// confirms, or a digit (enter, the first) the option it picks.
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
    // Options with `yesNo` ask whether to go ahead, with the one command that does.
    confirm: { for: string; reason: string; options: Option[]; yesNo: boolean } | null;
    sent: Set<string>;
  }>({ card: newCard(), cardFor: null, form: null, confirm: null, sent: new Set() });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  const itemKey = item ? keyOf(item) : null;
  const card = item?.kind === 'attention' && sheet.current.cardFor === itemKey ? sheet.current.card : newCard();
  const form = itemKey !== null && sheet.current.form?.for === itemKey ? sheet.current.form : null;
  const formChoice = form && item ? choicesFor(item, task)[form.choice] : undefined;
  // The fields being filled in, with the choice they are for, while it still takes them.
  const filling = form && formChoice && 'fields' in formChoice ? { form, choice: formChoice } : null;
  const confirm = itemKey !== null && sheet.current.confirm?.for === itemKey ? sheet.current.confirm : null;

  const send = (command: Command, opens = false) => {
    if (!item || itemKey === null) return;
    const { taskId } = item;
    const sentFor = itemKey;
    // An answered request leaves the queue, so its digits stay spent. A root
    // in review stays there after its choice goes through (a push to its PR
    // keeps it In review), so its digits answer again once the daemon replies.
    const stays = item.kind === 'review';
    sheet.current.sent.add(sentFor);
    onSend?.();
    void connection.send(command).then((reply) => {
      if (!reply.ok || stays) sheet.current.sent.delete(sentFor);
      if (!reply.ok && sheet.current.cardFor === sentFor) sheet.current.card = newCard();
      if (!reply.ok && reply.confirm) {
        sheet.current.confirm = { for: sentFor, reason: reply.reason, options: [{ label: 'yes', command: reply.confirm }], yesNo: true };
      } else if (!reply.ok && reply.choose?.length) {
        sheet.current.confirm = { for: sentFor, reason: reply.reason, options: reply.choose, yesNo: false };
      } else onReply({ reply, taskId, opens });
      rerender();
    });
  };
  // A digit on the item's sheet: an option of its question's card (toggled
  // on a multi-select, which enter confirms), or a choice.
  const answer = (input: string, key: Key) => {
    if (!item || itemKey === null || sheet.current.sent.has(itemKey)) return;
    if (item.kind === 'attention' && item.question && item.taskId) {
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
    if (key.escape || !filling) sheet.current.form = null;
    else {
      const { form, choice } = filling;
      const command = key.return ? choice.send(form.values) : null;
      if (command) {
        sheet.current.form = null;
        send(command);
      } else if (key.upArrow) form.at = Math.max(form.at - 1, 0);
      else if (key.downArrow || key.tab) form.at = Math.min(form.at + 1, form.values.length - 1);
      else form.values[form.at] = edit(form.values[form.at]!, input, key) ?? form.values[form.at]!;
    }
    rerender();
  };
  // A key while the sheet asks whether to go ahead anyway (y does, n or esc
  // doesn't), or which way to (a digit or enter picks, esc backs out).
  const goAhead = (input: string, key: Key) => {
    const { options, yesNo } = confirm!;
    const picked = yesNo ? (input === 'y' ? options[0]! : input === 'n' || key.escape ? 'back' : null) : chooseKey(options, input, key);
    if (picked) sheet.current.confirm = null;
    if (picked && picked !== 'back') send(picked.command);
    rerender();
  };

  return {
    card,
    // The fields being filled in, if any: while they are, every key is theirs.
    form: filling && {
      fields: filling.choice.fields.map(({ prompt }, i) => ({ prompt, value: filling.form.values[i]! })),
      at: filling.form.at,
      enter: filling.choice.enter,
    },
    // What a refusal asks back, if anything: while it does, every key is its answer's.
    confirm: confirm && { reason: confirm.reason, options: confirm.yesNo ? null : confirm.options.map(({ label }) => label) },
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
  confirm?: Ask | null;
  // Whether esc gives the digits back to the screens: on Needs you, not in a
  // conversation, whose own hint says what its keys do.
  escBack?: boolean;
};

export function AnswerSheet({ item, task, card, answering, form, confirm = null, escBack = true }: Props) {
  const title = titleOf(item, task, { withId: true });
  const question = item.kind === 'attention' ? item.question : null;
  const hint = answerable(item, task)
    ? confirm !== null
      ? confirm.options ? null : 'y yes · n no'
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
      h(Text, { key: `field-${i}` }, form!.fields.length > 1 ? (i === form!.at ? '› ' : '  ') : '', h(Text, { bold: true }, `${prompt}: `), shownRule(value)),
    ),
    confirm?.options ? h(ChoosePrompt, { reason: confirm.reason, options: confirm.options }) : null,
    confirm && !confirm.options ? h(Text, { color: 'yellow' }, confirm.reason) : null,
    hint ? h(Text, { dimColor: true }, hint) : null,
  );
}
