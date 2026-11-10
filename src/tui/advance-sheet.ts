// The advance sheet (`ctrl+n` in a conversation): the operator confirms
// moving a HITL task on from its stage to the next HITL one, skipping
// optional stages on the way. An AFK stage next is the handoff's to start.
// On a ticket of a work loop over a map, it finishes the ticket.
import { createElement as h, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { TaskView } from '../protocol/factory-state.ts';
import { Cursor, Sheet, tone } from './theme.ts';

type Props = {
  connection: FactoryConnection;
  task: TaskView;
  // The task advanced: the conversation carries on with its next run.
  onAdvanced(): void;
  onCancel(): void;
};

// Whether the sheet has anything to offer on the task: a preset and a stage.
export function canAdvance(task: TaskView | undefined): task is TaskView & { preset: NonNullable<TaskView['preset']>; stage: string } {
  return !!task?.preset && !!task.stage && task.mode === 'HITL';
}

export function AdvanceSheet({ connection, task, onAdvanced, onCancel }: Props) {
  const { stages } = task.preset!;
  const after = stages.slice(stages.findIndex(({ id }) => id === task.stage) + 1);
  const afk = after.findIndex(({ mode }) => mode === 'AFK');
  // The HITL stages the task can go on to, and what follows them.
  const rows = afk < 0 ? after : after.slice(0, afk);
  const handoff = afk < 0 ? null : after[afk]!;
  // Kept in one state: keys typed in one burst arrive before a re-render.
  const [sheet, setSheet] = useState({ cursor: 0, skipped: [] as string[] });
  const [refusal, setRefusal] = useState<string | null>(null);
  // Only stages before the one advanced to are skipped.
  const target = rows.findIndex(({ id }) => !sheet.skipped.includes(id));
  const to = target < 0 ? rows.length : target;
  const skip = rows.slice(0, to).map(({ id }) => id);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      void connection.send({ type: 'advanceStage', taskId: task.id, ...(skip.length > 0 && { skip }) }).then((reply) => {
        if (reply.ok) onAdvanced();
        else setRefusal(reply.reason);
      });
      return;
    }
    setSheet(({ cursor, skipped }) => {
      if (key.upArrow || key.downArrow) return { skipped, cursor: Math.min(Math.max(cursor + (key.upArrow ? -1 : 1), 0), Math.max(rows.length - 1, 0)) };
      const row = rows[cursor];
      if (input !== ' ' || !row?.optional) return { cursor, skipped };
      // Taking a skip back also takes back the ones after it; a skip past
      // the stage advanced to skips everything up to it.
      if (skipped.includes(row.id)) return { cursor, skipped: rows.slice(0, cursor).map(({ id }) => id).filter((id) => skipped.includes(id)) };
      const upTo = rows.slice(0, cursor + 1);
      return upTo.every((stage) => stage.optional) ? { cursor, skipped: upTo.map(({ id }) => id) } : { cursor, skipped };
    });
  });

  // At a work loop, confirming finishes the ticket its run works instead.
  const ticket = task.loop && !task.loop.cleared ? task.loop.ticket : null;
  if (ticket) {
    return h(
      Sheet,
      { title: `Advance ${task.id} from ${task.stage}`, hint: 'enter finish the ticket · esc back' },
      h(Text, null, `Finish ${ticket}: the factory reads the map again for its next frontier.`),
      refusal ? h(Text, tone('bad'), refusal) : null,
    );
  }
  const then = handoff
    ? rows.length === 0
      ? h(Text, tone('warn'), `The next stage, ${handoff.id}, is AFK: hand ${task.id} off to start it.`)
      : h(Text, tone('dim'), `then ${handoff.id} (AFK): the handoff starts it`)
    : rows.length === 0
      ? h(Text, tone('warn'), `${task.stage} is the last stage: advancing puts ${task.id} in review.`)
      : h(Text, tone('dim'), 'then In review');
  return h(
    Sheet,
    { title: `Advance ${task.id} from ${task.stage}`, hint: `enter advance${rows.some((stage) => stage.optional) ? ' · ↑↓ stage · space skip' : ''} · esc back` },
    ...rows.map((stage, i) =>
      h(
        Box,
        { key: stage.id, gap: 1 },
        h(Cursor, { on: i === sheet.cursor }),
        h(Box, { width: 16 }, h(Text, { ...tone(i < to ? 'dim' : 'fg'), bold: i === to }, stage.id)),
        h(Text, tone('dim'), [stage.model, stage.optional && 'optional', i < to && '· skipped'].filter(Boolean).join(' ')),
        i === to ? h(Text, tone('ok'), '← advances here') : null,
      ),
    ),
    then,
    refusal ? h(Text, tone('bad'), refusal) : null,
  );
}
