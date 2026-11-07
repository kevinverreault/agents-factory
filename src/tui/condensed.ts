// The condensed view (`v`): three panes over the same state as the screens.
// The sidebar holds Needs you and the groups, the middle pane the task tree,
// and the right one the detail of whichever task the selection is on. `tab`
// moves the focus across them and `f` zooms the detail to the whole width.
import { createElement as h, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import type { FactoryState, TaskView } from '../protocol/factory-state.ts';
import { waitingFor } from './answer-sheet.ts';
import { CursorWindow } from './screen.ts';

export type Pane = 'sidebar' | 'tree' | 'detail';
// The order `tab` moves the focus in.
export const PANES: Pane[] = ['sidebar', 'tree', 'detail'];

// The three panes side by side, the focused one's border lit; zoomed, the
// detail alone.
export function Condensed({
  focus,
  zoom,
  sidebar,
  tree,
  detail,
}: {
  focus: Pane;
  zoom: boolean;
  sidebar: ReactNode;
  tree: ReactNode;
  detail: ReactNode;
}) {
  const pane = (id: Pane, content: ReactNode, size: { width?: number; flexGrow?: number; flexBasis?: number }) =>
    h(
      Box,
      {
        key: id,
        ...size,
        flexShrink: size.width === undefined ? 1 : 0,
        flexDirection: 'column',
        overflow: 'hidden',
        borderStyle: 'single',
        borderColor: focus === id ? 'cyan' : 'gray',
        paddingX: 1,
      },
      content,
    );
  return h(
    Box,
    { flexDirection: 'row', flexShrink: 1, flexGrow: 1, overflow: 'hidden' },
    ...(zoom
      ? [pane('detail', detail, { flexGrow: 1 })]
      : [pane('sidebar', sidebar, { width: 28 }), pane('tree', tree, { flexGrow: 1, flexBasis: 0 }), pane('detail', detail, { flexGrow: 1, flexBasis: 0 })]),
  );
}

// Needs you, each item a row with what it waits for, the cursor on one while
// the sidebar has the focus; then every group with its tasks counted, the one
// the tree is filtered by marked.
export function Sidebar({
  state,
  cursor,
  focused,
  groups,
  group,
}: {
  state: FactoryState;
  cursor: number;
  focused: boolean;
  groups: [string, number][];
  group: string | null;
}) {
  const queue = state.attentionQueue;
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, `Needs you (${queue.length})`),
    queue.length === 0
      ? h(Text, { dimColor: true }, 'Nothing needs you.')
      : h(CursorWindow, {
          cursor,
          items: queue.map((item, i) => h(Item, { key: keyOf(item), item, task: item.taskId ? state.tasks[item.taskId] : undefined, selected: focused && i === cursor })),
        }),
    h(Box, { marginTop: 1 }, h(Text, { bold: true }, 'Groups')),
    groups.length === 0 ? h(Text, { dimColor: true }, 'None yet.') : null,
    ...groups.map(([name, count]) =>
      h(
        Box,
        { key: name, gap: 1 },
        h(Text, { color: 'cyan' }, name === group ? '•' : ' '),
        h(Box, { flexGrow: 1 }, h(Text, { wrap: 'truncate', bold: name === group }, name)),
        h(Text, { dimColor: true }, String(count)),
      ),
    ),
  );
}

// A Needs you item on one row: its task and what it waits for.
function Item({ item, task, selected }: { item: AttentionQueueItem; task: TaskView | undefined; selected: boolean }) {
  return h(
    Box,
    { gap: 1 },
    h(Box, { flexShrink: 0 }, h(Text, { color: 'cyan' }, selected ? '›' : ' ')),
    h(Box, { flexShrink: 0 }, h(Text, { bold: true }, (item.taskId ?? '').padEnd(3))),
    h(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, h(Text, { wrap: 'truncate' }, waitingFor(item, task))),
  );
}

function keyOf(item: AttentionQueueItem): string {
  return item.kind === 'attention' ? item.requestId : `${item.kind}-${item.taskId}`;
}

// Every group a task is tagged with, by name, and how many tasks it has.
export function groupCounts(tasks: TaskView[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const task of tasks) for (const group of task.groups) counts.set(group, (counts.get(group) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}
