// The `:` command line: a line typed at the bottom of the screen, run with
// enter, set aside with esc. `:task <id>` jumps to a task's detail (`9`,
// `t9` and `T9` all name T9), `:group <name>` filters the task tree by a
// group, and `:group` alone clears the filter.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import type { FactoryState } from '../protocol/factory-state.ts';

// Where a line takes the operator, or why it can't.
export type Jump = { to: 'task'; taskId: string } | { to: 'group'; group: string | null } | { refused: string };

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
  return { refused: `Unknown command :${line.trim()}. Try :task <id> or :group <name>.` };
}

// The line being typed, its cursor at the end.
export function CommandLine({ draft }: { draft: string }) {
  return h(Box, null, h(Text, null, `:${draft}`), h(Text, { inverse: true }, ' '));
}
