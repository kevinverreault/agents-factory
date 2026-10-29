// Seam 3 (Ink half): what Ink's useInput makes of Backspace and ctrl+h. Which
// bytes Windows Terminal sends for each key is the operator's half
// (`npm run probe:keys`), recorded in docs/walking-skeleton.md.
import { Text, useInput, type Key } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, test } from 'vitest';

type Pressed = { input: string; backspace: boolean; ctrl: boolean };

function Keys({ onKey }: { onKey: (input: string, key: Key) => void }) {
  useInput(onKey);
  return <Text>keys</Text>;
}

async function press(sequence: string): Promise<Pressed> {
  const pressed: Pressed[] = [];
  const app = render(<Keys onKey={(input, key) => pressed.push({ input, backspace: key.backspace, ctrl: key.ctrl })} />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.stdin.write(sequence);
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.unmount();
  return pressed[0]!;
}

describe('ctrl+h and Backspace in Ink', () => {
  test('with legacy key bytes, BS (0x08, ctrl+h) and DEL (0x7f) both read as a plain backspace', async () => {
    expect(await press('\x08')).toEqual({ input: '', backspace: true, ctrl: false });
    expect(await press('\x7f')).toEqual({ input: '', backspace: true, ctrl: false });
  });

  test('with the kitty keyboard protocol, ctrl+h reads as ctrl+h and Backspace as backspace', async () => {
    expect(await press('\x1b[104;5u')).toEqual({ input: 'h', backspace: false, ctrl: true });
    expect(await press('\x1b[127u')).toEqual({ input: '', backspace: true, ctrl: false });
  });
});
