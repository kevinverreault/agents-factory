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
import { border, Cursor, GLYPH, Heading, kindRole, tone } from './theme.ts';

export type Pane = 'sidebar' | 'tree' | 'detail';
// The order `tab` moves the focus in.
export const PANES: Pane[] = ['sidebar', 'tree', 'detail'];

// The three panes side by side, a `│` between them, each under its title,
// the focused one's lit; zoomed, the detail alone. The sidebar titles its
// own sections. `group` is what the tree is filtered by.
export function Condensed({
  focus,
  zoom,
  group,
  sidebar,
  tree,
  detail,
}: {
  focus: Pane;
  zoom: boolean;
  group: string | null;
  sidebar: ReactNode;
  tree: ReactNode;
  detail: ReactNode;
}) {
  const titles: Record<Pane, string | null> = { sidebar: null, tree: `Tasks · ${group ?? 'all'}`, detail: zoom ? 'Detail · zoomed' : 'Detail' };
  const pane = (id: Pane, content: ReactNode, size: { width?: number; flexGrow?: number; flexBasis?: number }, divided: boolean) =>
    h(
      Box,
      {
        key: id,
        ...size,
        flexShrink: size.width === undefined ? 1 : 0,
        flexDirection: 'column',
        overflow: 'hidden',
        paddingX: 1,
        ...(divided ? { borderStyle: 'single', borderTop: false, borderBottom: false, borderRight: false, ...border('line') } : {}),
      },
      titles[id] ? h(Heading, { text: titles[id], role: focus === id ? 'accent' : 'dim' }) : null,
      content,
    );
  return h(
    Box,
    { flexDirection: 'row', flexShrink: 1, flexGrow: 1, overflow: 'hidden' },
    ...(zoom
      ? [pane('detail', detail, { flexGrow: 1 }, false)]
      : [
          pane('sidebar', sidebar, { width: 28 }, false),
          pane('tree', tree, { flexGrow: 1, flexBasis: 0 }, true),
          pane('detail', detail, { flexGrow: 1, flexBasis: 0 }, true),
        ]),
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
    h(Heading, { text: `Needs you (${queue.length})`, role: focused ? 'accent' : 'dim' }),
    queue.length === 0
      ? h(Text, tone('dim'), 'Nothing needs you.')
      : h(CursorWindow, {
          cursor,
          items: queue.map((item, i) => h(Item, { key: keyOf(item), item, task: item.taskId ? state.tasks[item.taskId] : undefined, selected: focused && i === cursor })),
        }),
    h(Box, { marginTop: 1 }, h(Heading, { text: 'Groups' })),
    groups.length === 0 ? h(Text, tone('dim'), 'None yet.') : null,
    ...groups.map(([name, count]) =>
      h(
        Box,
        { key: name, gap: 1 },
        h(Text, tone('accent'), name === group ? GLYPH.marked : ' '),
        h(Box, { flexGrow: 1 }, h(Text, { ...tone(name === group ? 'accent' : 'fg'), wrap: 'truncate', bold: name === group }, name)),
        h(Text, tone('dim'), String(count)),
      ),
    ),
  );
}

// A Needs you item on one row: its task and what it waits for.
function Item({ item, task, selected }: { item: AttentionQueueItem; task: TaskView | undefined; selected: boolean }) {
  return h(
    Box,
    { gap: 1 },
    h(Cursor, { on: selected }),
    h(Box, { flexShrink: 0 }, h(Text, tone('dim'), (item.taskId ?? '').padEnd(3))),
    h(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, h(Text, { ...tone(kindRole(item)), wrap: 'truncate' }, waitingFor(item, task))),
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
