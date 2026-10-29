// Operator probe: shows, for each keypress, the raw bytes the terminal sent and
// what Ink's useInput made of them. Run `npm run probe:keys` (or
// `npm run probe:keys -- --kitty` to ask for the kitty keyboard protocol) in
// Windows Terminal and press Backspace, ctrl+h and ctrl+Backspace; ctrl+c quits.
// Plain .ts (no JSX) so Node runs it without a build step.
import type { EventEmitter } from 'node:events';
import { createElement as h, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useInput, useStdin } from 'ink';

type Seen = { raw: string; input: string; backspace: boolean; ctrl: boolean };

function hex(sequence: string): string {
  return [...sequence].map((char) => char.codePointAt(0)!.toString(16).padStart(2, '0')).join(' ');
}

function KeyProbe() {
  const [seen, setSeen] = useState<Seen[]>([]);
  const lastRaw = useRef('');
  // Ink's raw input event is internal (untyped); fine for a probe, not for the TUI.
  const events = (useStdin() as unknown as { internal_eventEmitter: EventEmitter }).internal_eventEmitter;

  useEffect(() => {
    const onRaw = (sequence: string) => (lastRaw.current = sequence);
    events.on('input', onRaw);
    return () => void events.off('input', onRaw);
  }, [events]);

  useInput((input, key) => {
    const entry = { raw: lastRaw.current, input, backspace: key.backspace, ctrl: key.ctrl };
    setSeen((list) => [...list.slice(-9), entry]);
  });

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, 'Press Backspace, ctrl+h and ctrl+Backspace (ctrl+c quits):'),
    ...seen.map((entry, index) =>
      h(
        Text,
        { key: index },
        `raw [${hex(entry.raw)}] input=${JSON.stringify(entry.input)} backspace=${entry.backspace} ctrl=${entry.ctrl}`,
      ),
    ),
  );
}

render(h(KeyProbe), {
  kittyKeyboard: process.argv.includes('--kitty') ? { mode: 'auto', flags: ['disambiguateEscapeCodes'] } : { mode: 'disabled' },
});
