// The advance sheet (`ctrl+n` in a conversation): the operator confirms
// moving a HITL task on from its stage to the next HITL one, skipping
// optional stages on the way. An AFK stage next is the handoff's to start.
import { createElement as h, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { TaskView } from '../protocol/factory-state.ts';

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

  const then = handoff
    ? rows.length === 0
      ? h(Text, { color: 'yellow' }, `The next stage, ${handoff.id}, is AFK: hand ${task.id} off to start it.`)
      : h(Text, { dimColor: true }, `then ${handoff.id} (AFK): the handoff starts it`)
    : rows.length === 0
      ? h(Text, { color: 'yellow' }, `${task.stage} is the last stage: advancing puts ${task.id} in review.`)
      : h(Text, { dimColor: true }, 'then In review');
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true }, `Advance ${task.id} from ${task.stage}`),
    ...rows.map((stage, i) =>
      h(
        Box,
        { key: stage.id, gap: 1 },
        h(Text, { color: 'cyan' }, i === sheet.cursor ? '›' : ' '),
        h(Box, { width: 16 }, h(Text, { bold: i === to, dimColor: i < to }, stage.id)),
        h(Text, { dimColor: true }, [stage.model, stage.optional && 'optional', i < to && '· skipped'].filter(Boolean).join(' ')),
        i === to ? h(Text, { color: 'green' }, '← advances here') : null,
      ),
    ),
    then,
    refusal ? h(Text, { color: 'red' }, refusal) : null,
    h(Text, { dimColor: true }, `enter advance${rows.some((stage) => stage.optional) ? ' · ↑↓ stage · space skip' : ''} · esc back`),
  );
}
