// The advance sheet (`ctrl+n` in a conversation): the operator confirms
// moving a HITL task on from its stage to the next HITL one, skipping
// optional stages on the way. An AFK stage next is the handoff's to start.
// On a ticket of a work loop over a map, it finishes the ticket. From a
// contained stage, it shows as it opens what blocks the work coming out of
// the container, and when the container and the host both changed the task
// branch, `ctrl+g` asks the agent to merge the host branch in (ADR 0015).
import { createElement as h, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { TaskView } from '../protocol/factory-state.ts';
import type { AdvanceCheck } from '../protocol/protocol.ts';
import { useInFlight } from './in-flight.ts';
import { Cursor, GLYPH, MERGE_HINT, Sheet, tone } from './theme.ts';

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
  // What blocks the bring-out, as the factory found it when the sheet
  // opened, or the last refusal, and whether it offers to ask the agent to
  // merge the host branch.
  const [check, setCheck] = useState<AdvanceCheck | null>(null);
  const [offer, setOffer] = useState(false);
  useEffect(() => {
    void connection.send({ type: 'checkAdvance', taskId: task.id }).then((reply) => {
      const found = reply.ok ? (reply.value as AdvanceCheck | undefined) : undefined;
      if (!found) return;
      setCheck(found);
      setOffer(found.mergesHost);
    });
  }, [connection, task.id]);
  // The advance spins until the daemon answers it.
  const inFlight = useInFlight(connection);
  // Only stages before the one advanced to are skipped.
  const target = rows.findIndex(({ id }) => !sheet.skipped.includes(id));
  const to = target < 0 ? rows.length : target;
  const skip = rows.slice(0, to).map(({ id }) => id);

  useInput((input, key) => {
    // An advance under way isn't backed out of: its reply says how it ended.
    if (key.escape) return inFlight.under() ? undefined : onCancel();
    if (key.ctrl && input === 'g') {
      // Asked, the conversation carries on: the agent hears it on the operator's turn.
      if (offer) void inFlight.send('Asking the agent…', { type: 'askToMergeHost', taskId: task.id })?.then((reply) => (reply.ok ? onCancel() : setRefusal(reply.reason)));
      return;
    }
    if (key.return) {
      void inFlight.send('Advancing…', { type: 'advanceStage', taskId: task.id, ...(skip.length > 0 && { skip }) })?.then((reply) => {
        if (reply.ok) return onAdvanced();
        setRefusal(reply.reason);
        setOffer(reply.confirm?.type === 'askToMergeHost');
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
      { title: `Advance ${task.id} from ${task.stage}`, hint: `enter finish the ticket${offer ? ` · ${MERGE_HINT}` : ''} · esc back` },
      h(Text, null, `Finish ${ticket}: the factory reads the map again for its next frontier.`),
      inFlight.indicator,
      ...blocked(refusal, check),
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
    { title: `Advance ${task.id} from ${task.stage}`, hint: `enter advance${rows.some((stage) => stage.optional) ? ' · ↑↓ stage · space skip' : ''}${offer ? ` · ${MERGE_HINT}` : ''} · esc back` },
    ...rows.map((stage, i) =>
      h(
        Box,
        { key: stage.id, gap: 1 },
        h(Cursor, { on: i === sheet.cursor }),
        h(Box, { width: 16 }, h(Text, { ...tone(i < to ? 'dim' : 'fg'), bold: i === to }, stage.id)),
        h(Text, tone('dim'), [stage.model, stage.optional && 'optional', i < to && '· skipped'].filter(Boolean).join(' ')),
        i === to ? h(Text, tone('ok'), `${GLYPH.advances} advances here`) : null,
      ),
    ),
    then,
    inFlight.indicator,
    ...blocked(refusal, check),
  );
}

// The last refusal, or else what blocks the bring-out as the sheet found it.
function blocked(refusal: string | null, check: AdvanceCheck | null) {
  if (refusal) return [h(Text, { key: 'refusal', ...tone('bad') }, refusal)];
  return (check?.blockers ?? []).map((blocker, i) => h(Text, { key: `blocker-${i}`, ...tone('bad') }, `${GLYPH.failed} ${blocker}`));
}
