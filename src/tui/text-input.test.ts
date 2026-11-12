import type { Key } from 'ink';
import { describe, expect, test } from 'vitest';
import { edit, withCaret, type Caret } from './text-input.ts';

const NO_KEY: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
  super: false, hyper: false, capsLock: false, numLock: false,
};
const key = (pressed: Partial<Key>): Key => ({ ...NO_KEY, ...pressed });

// The line after each press, shown with its caret.
function typed(text: string, caret: Caret, ...presses: [string, Partial<Key>][]): string {
  let line = { text, caret };
  for (const [input, pressed] of presses) line = edit(line.text, line.caret, input, key(pressed)) ?? line;
  return withCaret(line.text, line.caret);
}
const LEFT: [string, Partial<Key>] = ['', { leftArrow: true }];
const RIGHT: [string, Partial<Key>] = ['', { rightArrow: true }];

describe('a line the operator types', () => {
  test('starts with its caret at the end, where typing adds', () => {
    expect(typed('fix', null, ['es', {}])).toBe('fixes▏');
  });

  test('← and → move the caret a character, typing inserts there, and it stops at either end', () => {
    expect(typed('fix bug', null, LEFT, LEFT, LEFT, ['the ', {}])).toBe('fix the ▏bug');
    expect(typed('ab', null, LEFT, LEFT, LEFT)).toBe('▏ab');
    expect(typed('ab', 0, RIGHT, RIGHT, RIGHT)).toBe('ab▏');
  });

  test('home and end go to the start and end of the line', () => {
    expect(typed('fix bug', null, ['', { home: true }], ['Please ', {}])).toBe('Please ▏fix bug');
    expect(typed('fix bug', 2, ['', { end: true }], ['!', {}])).toBe('fix bug!▏');
  });

  test('ctrl+← →, alt+← → and alt+b f move a word: back to its start, on to its end', () => {
    expect(typed('add a --json flag', null, ['', { leftArrow: true, ctrl: true }])).toBe('add a --json ▏flag');
    expect(typed('add a --json flag', null, ['', { leftArrow: true, ctrl: true }], ['', { leftArrow: true, meta: true }])).toBe('add a --▏json flag');
    expect(typed('add a --json flag', 0, ['', { rightArrow: true, ctrl: true }], ['f', { meta: true }])).toBe('add a▏ --json flag');
    expect(typed('add a --json flag', null, ['b', { meta: true }], ['b', { meta: true }], ['b', { meta: true }], ['b', { meta: true }], ['b', { meta: true }])).toBe('▏add a --json flag');
  });

  test('backspace deletes before the caret, delete after it, and neither past an end', () => {
    expect(typed('fix tbhe bug', 6, ['', { backspace: true }])).toBe('fix t▏he bug');
    expect(typed('fix tbhe bug', 5, ['', { delete: true }])).toBe('fix t▏he bug');
    expect(typed('ab', 0, ['', { backspace: true }])).toBe('▏ab');
    expect(typed('ab', null, ['', { delete: true }])).toBe('ab▏');
  });

  test('a character outside the BMP moves and deletes as one', () => {
    expect(typed('a😀b', null, LEFT, LEFT, ['x', {}])).toBe('ax▏😀b');
    expect(typed('a😀', null, ['', { backspace: true }])).toBe('a▏');
  });

  test('a caret left past the end of shorter text is at its end', () => {
    expect(typed('', 7, ['a', {}])).toBe('a▏');
  });

  test('keys that neither edit nor move leave the line to the screen', () => {
    for (const pressed of [{ upArrow: true }, { downArrow: true }, { return: true }, { escape: true }, { tab: true }]) {
      expect(edit('x', null, '', key(pressed))).toBeNull();
    }
    expect(edit('x', null, 'h', key({ ctrl: true }))).toBeNull();
    expect(edit('x', null, 'x', key({ meta: true }))).toBeNull();
  });
});
