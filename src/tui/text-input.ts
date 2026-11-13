// One line of text the operator types, edited key by key at its caret.
import type { Key } from 'ink';
import { GLYPH } from './theme.ts';

// Where the caret is in the text: an index into it, or null at its end. A
// line starts with its caret at the end, and goes back there whenever the
// text is set anew or another line is picked.
export type Caret = number | null;
export type Typed = { text: string; caret: Caret };

// The caret's index in `text`, one past its end held to the end.
export function caretIn(text: string, caret: Caret): number {
  return caret === null ? text.length : Math.min(Math.max(caret, 0), text.length);
}

// The text and its caret after `input`, or null when the key neither edits
// the line nor moves the caret in it:
//   ← →                  a character
//   ctrl or alt + ← →    a word, as alt+b and alt+f do
//   home end             the start or end of the line
//   backspace            deletes the character before the caret
//   delete               deletes the character after it
export function edit(text: string, caret: Caret, input: string, key: Key): Typed | null {
  const at = caretIn(text, caret);
  const to = (index: number): Typed => ({ text, caret: index });
  if (key.home) return to(0);
  if (key.end) return to(text.length);
  if (key.leftArrow || key.rightArrow) {
    const by = key.leftArrow ? -1 : 1;
    return to(key.ctrl || key.meta ? word(text, at, by) : character(text, at, by));
  }
  if (key.meta && (input === 'b' || input === 'f')) return to(word(text, at, input === 'b' ? -1 : 1));
  if (key.backspace) {
    const from = character(text, at, -1);
    return { text: text.slice(0, from) + text.slice(at), caret: from };
  }
  if (key.delete) return { text: text.slice(0, at) + text.slice(character(text, at, 1)), caret: at };
  if (key.ctrl || key.meta || key.return || key.tab || key.escape || key.upArrow || key.downArrow || !input) return null;
  return insert(text, caret, input);
}

// The text with `input` typed or pasted at its caret, the caret after it.
export function insert(text: string, caret: Caret, input: string): Typed {
  const at = caretIn(text, caret);
  return { text: text.slice(0, at) + input + text.slice(at), caret: at + input.length };
}

// The text with the caret glyph where the caret is.
export function withCaret(text: string, caret: Caret): string {
  const at = caretIn(text, caret);
  return `${text.slice(0, at)}${GLYPH.caret}${text.slice(at)}`;
}

// The index a character before (-1) or after (1) `at`, a surrogate pair one character.
function character(text: string, at: number, by: -1 | 1): number {
  if (by < 0) return at <= 0 ? 0 : at - (isLow(text, at - 1) && isHigh(text, at - 2) ? 2 : 1);
  return at >= text.length ? text.length : at + (isHigh(text, at) && isLow(text, at + 1) ? 2 : 1);
}

// The start of the word before `at` (-1), or the end of the word after it (1).
function word(text: string, at: number, by: -1 | 1): number {
  let index = at;
  const next = () => (by < 0 ? text[index - 1] : text[index]);
  while (next() !== undefined && !WORD.test(next()!)) index += by;
  while (next() !== undefined && WORD.test(next()!)) index += by;
  return index;
}
const WORD = /[\p{L}\p{N}_]/u;

export const isHigh = (text: string, i: number) => /[\uD800-\uDBFF]/.test(text[i] ?? '');
export const isLow = (text: string, i: number) => /[\uDC00-\uDFFF]/.test(text[i] ?? '');
