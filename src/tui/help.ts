// `?` help: every key the screens take, until `?` or `esc` closes it.
import { createElement as h } from 'react';
import { Box, Text } from 'ink';

const KEYS: [string, string][] = [
  ['1–4', 'Tasks · Needs you · Runs · Usage, leaving any task’s detail'],
  ['↑ ↓', 'move'],
  ['enter', 'drill into a task’s detail; in a detail, open its conversation; on Needs you, answer or open'],
  ['esc', 'back out of a task’s detail'],
  ['N', 'new task, on the launch card'],
  ['a', 'answer the selected task’s request, on Needs you'],
  ['c', 'converse with a HITL task, or take an AFK one over'],
  ['x', 'cancel the selected task, with its subtree'],
  ['t', 're-tier the selected task’s next runs'],
  ['f', 'finish a loop after its ticket'],
  ['y', 'retry a failed task'],
  ['H', 'hide or show Done and Cancelled tasks'],
  ['ctrl+h', 'hand a HITL task off'],
  ['ctrl+b', 'leave a conversation, back to where you were'],
  ['?', 'this help'],
];

export function Help() {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, 'Keys'),
    ...KEYS.map(([key, does]) => h(Box, { key, gap: 2 }, h(Box, { width: 8, flexShrink: 0 }, h(Text, { bold: true }, key)), h(Text, null, does))),
    h(Text, { dimColor: true }, '? or esc closes'),
  );
}
