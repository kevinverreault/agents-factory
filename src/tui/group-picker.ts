// The group picker (`g`): All tasks, then every group with its tasks counted.
// ↑↓ move, enter filters the task tree by the group under the cursor (All
// tasks clears it), esc backs out.
import { createElement as h } from 'react';
import { Box, Text, type Key } from 'ink';
import { Cursor, GLYPH, Sheet, tone } from './theme.ts';

// What a key does on the picker: move its cursor to `cursor`, pick a group
// (null for All tasks), back out, or nothing.
export type PickerKey = { cursor: number } | { picked: string | null } | 'back' | null;

export function pickerKey(groups: string[], cursor: number, input: string, key: Key): PickerKey {
  if (key.escape) return 'back';
  if (key.return) return { picked: cursor === 0 ? null : (groups[cursor - 1] ?? null) };
  if (key.upArrow) return { cursor: Math.max(cursor - 1, 0) };
  if (key.downArrow) return { cursor: Math.min(cursor + 1, groups.length) };
  return null;
}

// Its cursor on row `cursor`, row 0 being All tasks; the group the tree is
// filtered by is ticked.
export function GroupPicker({ groups, cursor, current }: { groups: [string, number][]; cursor: number; current: string | null }) {
  const row = (key: string, label: string, count: string, i: number, filtering: boolean) =>
    h(
      Box,
      { key, gap: 1 },
      h(Cursor, { on: i === cursor }),
      h(Box, { width: 24 }, h(Text, { wrap: 'truncate', bold: i === cursor }, label)),
      h(Box, { width: 4, flexShrink: 0 }, h(Text, tone('dim'), count)),
      h(Text, tone('ok'), filtering ? GLYPH.current : ' '),
    );
  return h(
    Sheet,
    { title: 'Filter by group', hint: 'enter filters the tasks · esc back' },
    groups.length === 0 ? h(Text, tone('dim'), 'No task has a group yet.') : null,
    row('all', 'All tasks', '', 0, current === null),
    ...groups.map(([name, count], i) => row(name, name, String(count), i + 1, name === current)),
  );
}
