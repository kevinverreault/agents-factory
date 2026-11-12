// The `:` command line: a line typed at the bottom of the screen, run with
// enter, set aside with esc. `:task <id>` jumps to a task's detail (`9`,
// `t9` and `T9` all name T9), `:group <name>` filters the task tree by a
// group, `:group` alone clears the filter, and `:gc` opens the gc sheet on
// the leftovers that belong to no live task (ADR 0011).
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryState } from '../protocol/factory-state.ts';
import { caretIn, type Typed } from './text-input.ts';
import { Sheet, tone } from './theme.ts';

// Where a line takes the operator, or why it can't.
export type Jump = { to: 'task'; taskId: string } | { to: 'group'; group: string | null } | { to: 'gc' } | { refused: string };

// The line as typed, without its `:`.
export function runCommand(line: string, state: FactoryState): Jump {
  const [verb = '', ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  if (verb === 'task' && arg) {
    const taskId = /^\d+$/.test(arg) ? `T${arg}` : arg.toUpperCase();
    return state.tasks[taskId] ? { to: 'task', taskId } : { refused: `No task ${taskId}.` };
  }
  if (verb === 'group') {
    if (!arg) return { to: 'group', group: null };
    return Object.values(state.tasks).some((task) => task.groups.includes(arg)) ? { to: 'group', group: arg } : { refused: `No group ${arg}.` };
  }
  if (verb === 'gc' && !arg) return { to: 'gc' };
  return { refused: `Unknown command :${line.trim()}. Try :task <id>, :group <name> or :gc.` };
}

// The line being typed, the character under its caret inverse (a space at
// its end), on a sheet naming what it runs.
export function CommandLine({ line }: { line: Typed }) {
  const at = caretIn(line.text, line.caret);
  const point = line.text.codePointAt(at);
  const under = point === undefined ? '' : String.fromCodePoint(point);
  return h(
    Sheet,
    { title: 'Command', hint: 'task <id> · group <name> · group · gc · enter run · esc back' },
    h(Box, null, h(Text, null, `:${line.text.slice(0, at)}`), h(Text, { inverse: true }, under || ' '), h(Text, null, line.text.slice(at + under.length))),
  );
}
