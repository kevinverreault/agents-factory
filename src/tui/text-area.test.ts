import type { Key } from 'ink';
import { describe, expect, test } from 'vitest';
import { editArea, windowed } from './text-area.ts';
import { withCaret, type Caret } from './text-input.ts';

const NO_KEY: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
  super: false, hyper: false, capsLock: false, numLock: false,
};
type Press = [string, Partial<Key>];

// The text after each press, shown with its caret, or 'left' once a key
// leaves the text to what is around it.
function typed(text: string, caret: Caret, ...presses: Press[]): string {
  let area = { text, caret };
  for (const [input, pressed] of presses) {
    const next = editArea(area.text, area.caret, input, { ...NO_KEY, ...pressed });
    if (next === null) return 'left';
    area = next;
  }
  return withCaret(area.text, area.caret);
}
const BREAK: Press = ['\n', {}];
const UP: Press = ['', { upArrow: true }];
const DOWN: Press = ['', { downArrow: true }];

describe('text of several lines the operator types', () => {
  test('ctrl+j breaks the line at the caret, as a line feed or under the kitty protocol', () => {
    expect(typed('fix the bug', 3, BREAK)).toBe('fix\n▏ the bug');
    expect(typed('one', null, ['j', { ctrl: true }], ['two', {}])).toBe('one\ntwo▏');
  });

  test('enter is not a line break: the text leaves it to the card', () => {
    expect(typed('one', null, ['\r', { return: true }])).toBe('left');
  });

  test('a blank line makes a paragraph', () => {
    expect(typed('First.', null, BREAK, BREAK, ['Second.', {}])).toBe('First.\n\nSecond.▏');
  });

  test('a bulleted item continues its list, with its marker and indentation', () => {
    expect(typed('- item', null, BREAK)).toBe('- item\n- ▏');
    expect(typed('Steps:\n  * one', null, BREAK, ['two', {}])).toBe('Steps:\n  * one\n  * two▏');
  });

  test('a numbered item continues its list, counting up', () => {
    expect(typed('1. a', null, BREAK)).toBe('1. a\n2. ▏');
    expect(typed('9. a', null, BREAK, ['b', {}], BREAK)).toBe('9. a\n10. b\n11. ▏');
  });

  test('a break on an empty item ends the list, leaving an empty line', () => {
    expect(typed('- a', null, BREAK, BREAK)).toBe('- a\n▏');
    expect(typed('1. a', null, BREAK, BREAK, ['After.', {}])).toBe('1. a\nAfter.▏');
  });

  test('a break inside an item carries the rest onto the next item; one in its marker is plain', () => {
    expect(typed('- ab', 3, BREAK)).toBe('- a\n- ▏b');
    expect(typed('- ab', 0, BREAK)).toBe('\n▏- ab');
  });

  test('a line without a marker breaks plainly', () => {
    expect(typed('-not a list', null, BREAK)).toBe('-not a list\n▏');
    expect(typed('2026 plan', null, BREAK)).toBe('2026 plan\n▏');
  });

  test('↑ and ↓ move between lines at the same column, or the end of a shorter line', () => {
    expect(typed('abcd\nef\nghij', null, UP)).toBe('abcd\nef▏\nghij');
    expect(typed('abcd\nef\nghij', null, UP, UP)).toBe('ab▏cd\nef\nghij');
    expect(typed('abcd\nef\nghij', 3, DOWN, DOWN)).toBe('abcd\nef\ngh▏ij');
  });

  test('↑ on the first line and ↓ on the last leave the text', () => {
    expect(typed('one\ntwo', 2, UP)).toBe('left');
    expect(typed('one\ntwo', null, DOWN)).toBe('left');
    expect(typed('one', null, UP)).toBe('left');
  });

  test('home and end go to the start and end of the caret’s line', () => {
    expect(typed('one\ntwo\nthree', 5, ['', { home: true }])).toBe('one\n▏two\nthree');
    expect(typed('one\ntwo\nthree', 5, ['', { end: true }])).toBe('one\ntwo▏\nthree');
  });

  test('← →, backspace and delete cross line breaks', () => {
    expect(typed('one\ntwo', 4, ['', { leftArrow: true }])).toBe('one▏\ntwo');
    expect(typed('one\ntwo', 4, ['', { backspace: true }])).toBe('one▏two');
    expect(typed('one\ntwo', 3, ['', { delete: true }])).toBe('one▏two');
  });

  test('pasted text keeps its line breaks, as \\n', () => {
    expect(typed('', null, ['a\r\nb\rc\nd', {}])).toBe('a\nb\nc\nd▏');
  });
});

describe('a long text on show', () => {
  const text = ['1', '2', '3', '4', '5', '6'].join('\n');

  test('shows all of a short text', () => {
    expect(windowed('a\nb', null, 4)).toEqual({ shown: 'a\nb▏', above: 0, below: 0 });
  });

  test('shows the lines around the caret, counting those left out', () => {
    expect(windowed(text, 6, 3)).toEqual({ shown: '3\n▏4\n5', above: 2, below: 1 });
    expect(windowed(text, null, 3)).toEqual({ shown: '4\n5\n6▏', above: 3, below: 0 });
    expect(windowed(text, 0, 3)).toEqual({ shown: '▏1\n2\n3', above: 0, below: 3 });
  });

  test('without a caret, shows its first lines', () => {
    expect(windowed(text, undefined, 2)).toEqual({ shown: '1\n2', above: 0, below: 4 });
  });
});
