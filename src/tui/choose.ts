// What a refusal with `choose` asks: the daemon's reason, then its ways to go
// ahead, one per digit. Enter takes the first, the default; esc backs out.
// Cancel asks this way when work would be lost: Keep branch or Discard work.
import { createElement as h } from 'react';
import { Box, Text, type Key } from 'ink';
import type { Option } from '../protocol/protocol.ts';

// What a key does on the prompt: take an option, back out, or nothing.
export function chooseKey(options: Option[], input: string, key: Key): Option | 'back' | null {
  if (key.escape) return 'back';
  if (key.return) return options[0] ?? null;
  return /^[1-9]$/.test(input) ? (options[Number(input) - 1] ?? null) : null;
}

export function ChoosePrompt({ reason, options }: { reason: string; options: string[] }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: 'yellow' }, reason),
    ...options.map((label, i) => h(Box, { key: label, gap: 1 }, h(Text, { bold: true, color: 'cyan' }, String(i + 1)), h(Text, null, label))),
    h(Text, { dimColor: true }, `enter ${options[0]} · esc back`),
  );
}
