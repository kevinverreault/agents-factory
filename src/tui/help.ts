// `?` help: every key the screens and the condensed view take, until `?` or `esc` closes it.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import { Sheet, tone } from './theme.ts';

const KEYS: [string, string][] = [
  ['1–4', 'Tasks · Needs you · Runs · Usage, leaving any task’s detail or the condensed view'],
  ['↑ ↓', 'move'],
  ['enter', 'drill into a task’s detail; in a detail, open its conversation; on Needs you, answer or open'],
  ['esc', 'back out of a task’s detail, or the zoomed detail'],
  ['n', 'quick launch: one prompt, at most three questions, then the handoff'],
  ['N', 'new task, on the launch card'],
  ['a', 'answer the selected task’s request, on Needs you'],
  ['c', 'converse with a HITL task, or take an AFK one over'],
  ['x', 'cancel the selected task, with its subtree'],
  ['t', 're-tier the selected task’s next runs'],
  ['y', 'retry a failed task'],
  ['H', 'hide or show Done and Cancelled tasks'],
  ['v', 'the condensed view: Needs you and groups, the task tree, and the selected task’s detail; v again for the screens'],
  ['tab', 'in the condensed view, move the focus: sidebar, tree, detail'],
  ['f', 'in the condensed view, zoom the detail to the whole width, or back'],
  ['g', 'pick a group to filter the task tree by, or All tasks'],
  [':', 'the command line: :task <id> opens a task’s detail, :group <name> filters by a group, :group alone clears it, :gc lists the leftovers of no live task to delete'],
  ['ctrl+h', 'hand a HITL task off'],
  ['ctrl+e', 'expand a quick launch into its full conversation'],
  ['ctrl+b', 'leave a conversation, back to where you were'],
  ['home end', 'in a line being typed, the cursor to its start or end; ← → move it a character, and with ctrl or alt (or alt+b, alt+f) a word'],
  ['pgup pgdn', 'page back through a conversation taller than the screen, and down to its latest'],
  ['?', 'this help'],
];

export function Help() {
  return h(
    Sheet,
    { title: 'Keys', hint: '? or esc close' },
    ...KEYS.map(([key, does]) => h(Box, { key, gap: 2 }, h(Box, { width: 10, flexShrink: 0 }, h(Text, { ...tone('accent'), bold: true }, key)), h(Text, null, does))),
  );
}
