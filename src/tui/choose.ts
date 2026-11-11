// What a refusal with `choose` asks: the daemon's reason, then its ways to go
// ahead, one per digit. Enter takes the first, the default; esc backs out.
// Cancel asks this way when work would be lost: Keep branch or Discard work.
import { createElement as h } from 'react';
import { Box, Text, type Key } from 'ink';
import type { Option } from '../protocol/protocol.ts';
import { Option as Pick, Sheet, tone } from './theme.ts';

// What a key does on the prompt: take an option, back out, or nothing.
export function chooseKey(options: Option[], input: string, key: Key): Option | 'back' | null {
  if (key.escape) return 'back';
  if (key.return) return options[0] ?? null;
  return /^[1-9]$/.test(input) ? (options[Number(input) - 1] ?? null) : null;
}

// With a `title`, a sheet of its own; without, inside the sheet
// whose refusal asks it.
export function ChoosePrompt({ title, reason, options }: { title?: string; reason: string; options: string[] }) {
  const hint = `enter ${options[0]} · esc back`;
  const body = [
    h(Text, { key: 'reason', ...tone('warn') }, reason),
    ...options.map((label, i) => h(Pick, { key: label, digit: i + 1 }, label)),
  ];
  if (title !== undefined) return h(Sheet, { title, hint }, ...body);
  return h(Box, { flexDirection: 'column' }, ...body, h(Text, { key: 'hint', ...tone('dim') }, hint));
}
