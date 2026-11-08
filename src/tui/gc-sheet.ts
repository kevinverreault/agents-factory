// The gc sheet (ADR 0011): `:gc` in the TUI, and `agents-factory gc` on its
// own. It lists what belongs to no live task, nothing ticked; `space` ticks
// the leftover under the cursor, `a` ticks every one or none, and `enter`
// deletes only the ticked ones, then shows what happened to each. `esc`
// backs out, deleting nothing.
import { createElement as h, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { GcResult, Leftover, LeftoversView } from '../protocol/protocol.ts';

type Stage =
  | { kind: 'listing' }
  | { kind: 'ticking'; view: LeftoversView; cursor: number; ticked: boolean[] }
  | { kind: 'deleting' }
  | { kind: 'done'; result: GcResult }
  | { kind: 'refused'; reason: string };

const KINDS: Record<Leftover['kind'], string> = {
  worktree: 'worktree',
  branch: 'branch',
  'remote-branch': 'remote branch',
  container: 'container',
  image: 'image',
};

export function GcSheet({ connection, onLeave }: { connection: FactoryConnection; onLeave(): void }) {
  // In a ref too, so each key typed in one burst goes on from the last.
  const current = useRef<Stage>({ kind: 'listing' });
  const [stage, setStageState] = useState<Stage>(current.current);
  const setStage = (next: Stage) => {
    current.current = next;
    setStageState(next);
  };

  useEffect(() => {
    void connection.send({ type: 'listLeftovers' }).then((reply) => {
      if (!reply.ok) return setStage({ kind: 'refused', reason: reply.reason });
      const view = reply.value as LeftoversView;
      setStage({ kind: 'ticking', view, cursor: 0, ticked: view.leftovers.map(() => false) });
    });
  }, [connection]);

  const remove = (leftovers: Leftover[]) => {
    setStage({ kind: 'deleting' });
    void connection.send({ type: 'gc', leftovers }).then((reply) =>
      setStage(reply.ok ? { kind: 'done', result: reply.value as GcResult } : { kind: 'refused', reason: reply.reason }),
    );
  };

  useInput((input, key) => {
    if (key.escape) return onLeave();
    const stage = current.current;
    if (stage.kind !== 'ticking') return;
    const { view, cursor, ticked } = stage;
    const last = Math.max(view.leftovers.length - 1, 0);
    if (key.upArrow) setStage({ ...stage, cursor: Math.max(cursor - 1, 0) });
    else if (key.downArrow) setStage({ ...stage, cursor: Math.min(cursor + 1, last) });
    else if (input === ' ' && view.leftovers.length) setStage({ ...stage, ticked: ticked.map((on, i) => (i === cursor ? !on : on)) });
    else if (input === 'a') {
      const every = !ticked.every(Boolean);
      setStage({ ...stage, ticked: ticked.map(() => every) });
    } else if (key.return && ticked.some(Boolean)) remove(view.leftovers.filter((_, i) => ticked[i]).map(({ leftover }) => leftover));
  });

  const title = h(Text, { bold: true }, 'Leftovers', h(Text, { dimColor: true }, ' · what belongs to no live task; only what you tick is deleted'));
  if (stage.kind === 'listing') return column(title, h(Text, { dimColor: true }, 'Looking for leftovers…'));
  if (stage.kind === 'deleting') return column(title, h(Text, { dimColor: true }, 'Deleting the ticked leftovers…'));
  if (stage.kind === 'refused') return column(title, h(Text, { color: 'red' }, stage.reason), h(Text, { dimColor: true }, 'esc back'));
  if (stage.kind === 'done') {
    const { deleted, failed } = stage.result;
    return column(
      title,
      h(Text, null, `Deleted ${deleted.length}.`),
      ...failed.map(({ leftover, reason }, i) => h(Text, { key: `failed-${i}`, color: 'yellow' }, `${describeLeftover(leftover)}: ${reason}`)),
      h(Text, { dimColor: true }, 'esc back'),
    );
  }
  const { view, cursor, ticked } = stage;
  return column(
    title,
    ...view.unlisted.map((why, i) => h(Text, { key: `unlisted-${i}`, color: 'yellow' }, why)),
    ...(view.leftovers.length === 0
      ? [h(Text, { key: 'none', dimColor: true }, 'Nothing is left over: everything belongs to a live task.')]
      : view.leftovers.map(({ leftover, why }, i) =>
          h(
            Box,
            { key: `leftover-${i}`, gap: 1 },
            h(Text, { color: 'cyan' }, i === cursor ? '›' : ' '),
            h(Text, null, ticked[i] ? '[x]' : '[ ]'),
            h(Box, { width: 13, flexShrink: 0 }, h(Text, { bold: true }, KINDS[leftover.kind])),
            h(Text, null, `${subjectOf(leftover)} · ${why}`),
          ),
        )),
    h(Text, { dimColor: true }, view.leftovers.length ? 'space tick · a all or none · enter delete the ticked · esc back' : 'esc back'),
  );
}

// The leftover in a few words, as a failure names it.
export function describeLeftover(leftover: Leftover): string {
  return leftover.kind === 'container' ? `${leftover.taskId}’s container` : `${KINDS[leftover.kind]} ${subjectOf(leftover)}`;
}

function subjectOf(leftover: Leftover): string {
  switch (leftover.kind) {
    case 'worktree':
      return leftover.path;
    case 'branch':
      return `${leftover.branch} in ${leftover.repo}`;
    case 'remote-branch':
      return `${leftover.branch} on ${leftover.repo}’s origin`;
    case 'container':
      return leftover.taskId;
    case 'image':
      return leftover.image;
  }
}

function column(...children: ReturnType<typeof h>[]) {
  return h(Box, { flexDirection: 'column' }, ...children);
}
