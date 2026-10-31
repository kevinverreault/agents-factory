// The answer sheet: the bottom pane of Needs you, for the selected item. A
// question shows its card, whose options the digits pick; any other request
// lists what each digit does. Ready and review items take no digits here.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import type { TaskView } from '../protocol/factory-state.ts';
import type { Command } from '../protocol/protocol.ts';
import { QuestionCard, type Card } from './question-card.ts';

// What a digit on the sheet does. A choice that `opens` takes the operator
// into the task's conversation once the daemon accepts it.
export type Choice = { label: string; command: Command; opens?: boolean };

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
    case 'permission':
      return [{ label: 'Allow once', command: answer }];
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

type Props = {
  item: AttentionQueueItem;
  task: TaskView | undefined;
  // The card the operator is answering the item's question on.
  card: Card;
  // Whether the digits are the sheet's, not the screens'.
  answering: boolean;
};

export function AnswerSheet({ item, task, card, answering }: Props) {
  // A request about a repository itself has no task: the repository takes the title's place.
  const title = task ? `${task.id} ${task.title}` : item.kind === 'attention' ? item.repo : '';
  const question = item.kind === 'attention' ? item.question : null;
  const hint = answerable(item, task)
    ? answering
      ? 'digits answer · esc back'
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
    hint ? h(Text, { dimColor: true }, hint) : null,
  );
}
