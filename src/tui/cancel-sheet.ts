// The cancel sheet (ADR 0011): Cancel asks the operator once, Keep branch
// (the default) or Discard work, when the task branch holds commits found
// nowhere else. The daemon asks by refusing the cancel with those choices.
import { createElement as h } from 'react';
import { Box, Text, type Key } from 'ink';
import type { TaskView } from '../protocol/factory-state.ts';
import type { Command, Reply, ReplyChoice } from '../protocol/protocol.ts';

// What the sheet asks about the task's cancel.
export type CancelAsk = { taskId: string; reason: string; choices: ReplyChoice[] };

// What the reply to cancelling the task asks back, if anything.
export function cancelAsk(taskId: string, reply: Reply): CancelAsk | null {
  return !reply.ok && reply.choices?.length ? { taskId, reason: reply.reason, choices: reply.choices } : null;
}

// What a key on the sheet does: enter sends the default choice and a digit
// its own, esc backs out without cancelling, and any other key does nothing.
export function cancelSheetKey({ choices }: CancelAsk, input: string, key: Key): Command | 'back' | null {
  if (key.escape) return 'back';
  if (key.return) return choices[0]!.command;
  return /^[1-9]$/.test(input) ? (choices[Number(input) - 1]?.command ?? null) : null;
}

export function CancelSheet({ ask, task }: { ask: CancelAsk; task: TaskView | undefined }) {
  const title = task ? `${task.id} ${task.title}` : ask.taskId;
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { dimColor: true, wrap: 'truncate' }, `── Cancel ${title} ──`),
    h(Text, { color: 'yellow' }, ask.reason),
    ...ask.choices.map((choice, i) =>
      h(Box, { key: choice.label, gap: 1 }, h(Text, { bold: true, color: 'cyan' }, String(i + 1)), h(Text, null, choice.label)),
    ),
    h(Text, { dimColor: true }, `enter ${ask.choices[0]!.label.toLowerCase()} · esc back`),
  );
}
