// Text of several lines the operator types, such as a launch's prompt: the
// keys of a one-line input (text-input.ts), with these on lines:
//   ctrl+j            breaks the line, a list item continuing its list
//   ↑ ↓               the line above or below, at the same column
//   home end          the start or end of the caret's line
// Text pasted with line breaks keeps them, as \n.
import type { Key } from 'ink';
import { lineBreaks, wrapped } from '../text/lines.ts';
import { caretIn, edit, isHigh, isLow, withCaret, type Caret, type Typed } from './text-input.ts';

// The text and its caret after `input`, or null when the key neither edits
// the text nor moves the caret in it: as ↑ on the first line and ↓ on the
// last, which leave the text to whatever is above or below it.
export function editArea(text: string, caret: Caret, input: string, key: Key): Typed | null {
  const at = caretIn(text, caret);
  if (isLineBreak(input, key)) return breakLine(text, at);
  if (key.upArrow || key.downArrow) return verticalMove(text, at, key.upArrow ? -1 : 1);
  const { start, end } = lineAt(text, at);
  if (key.home) return { text, caret: start };
  if (key.end) return { text, caret: end };
  return edit(text, caret, key.ctrl || key.meta ? input : lineBreaks(input), key);
}

// ctrl+j, which a terminal sends as a line feed, or as ctrl and j under the
// kitty keyboard protocol. Enter is a carriage return: it isn't one.
export function isLineBreak(input: string, key: Key): boolean {
  return (input === '\n' && !key.ctrl && !key.meta) || (key.ctrl && !key.meta && input === 'j');
}

// The text broken at `at`. On a list item (`- `, `* ` or `1. `, however
// indented) the new line is the next item, numbered one on; on an item with
// nothing after its marker, the marker goes instead, ending the list.
export function breakLine(text: string, at: number): Typed {
  const { start, end } = lineAt(text, at);
  const item = LIST_ITEM.exec(text.slice(start, end));
  if (item && at >= start + item[0].length) {
    const [prefix, indent, marker, gap] = item as unknown as [string, string, string, string];
    if (text.slice(start + prefix.length, end).trim() === '') return { text: text.slice(0, start) + text.slice(end), caret: start };
    const next = /^\d+\.$/.test(marker) ? `${nextNumber(marker.slice(0, -1))}.` : marker;
    const inserted = `\n${indent}${next}${gap}`;
    return { text: text.slice(0, at) + inserted + text.slice(at), caret: at + inserted.length };
  }
  return { text: text.slice(0, at) + '\n' + text.slice(at), caret: at + 1 };
}
const LIST_ITEM = /^([ \t]*)([-*]|\d+\.)([ \t]+)/;

// The number after `digits`, as long as they were: 01 goes on to 02.
function nextNumber(digits: string): string {
  return (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
}

// The caret on the line `by` above (-1) or below (1), at its column or the
// end of a shorter line, or null when there is no such line.
export function verticalMove(text: string, at: number, by: -1 | 1): Typed | null {
  const { start, end } = lineAt(text, at);
  if (by < 0 ? start === 0 : end === text.length) return null;
  const line = lineAt(text, by < 0 ? start - 1 : end + 1);
  let caret = Math.min(line.start + (at - start), line.end);
  // Not between the halves of a character outside the BMP.
  if (isLow(text, caret) && isHigh(text, caret - 1)) caret--;
  return { text, caret };
}

// The start and end of the line `at` is on.
export function lineAt(text: string, at: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const found = text.indexOf('\n', at);
  return { start, end: found === -1 ? text.length : found };
}

// The text with its caret, wrapped `width` columns wide and held to `size`
// rows: those around the caret's, or the first when it has none. `above`
// and `below` count the rows left out.
export function windowed(text: string, caret: Caret | undefined, size: number, width = Infinity): { shown: string; above: number; below: number } {
  const rows: string[] = [];
  let caretRow = 0;
  const at = caret === undefined ? null : caretIn(text, caret);
  const caretLine = at === null ? -1 : text.slice(0, at).split('\n').length - 1;
  (at === null ? text : withCaret(text, at)).split('\n').forEach((line, index) => {
    const lineRows = wrapped(line, width);
    if (index === caretLine) {
      // The caret is on the first row its column doesn't reach the end of.
      let column = Array.from(text.slice(lineAt(text, at!).start, at!)).length;
      let row = 0;
      while (row < lineRows.length - 1 && column >= Array.from(lineRows[row]!).length) column -= Array.from(lineRows[row++]!).length;
      caretRow = rows.length + row;
    }
    rows.push(...lineRows);
  });
  if (rows.length <= size) return { shown: rows.join('\n'), above: 0, below: 0 };
  const from = Math.min(Math.max(caretRow - Math.floor(size / 2), 0), rows.length - size);
  return { shown: rows.slice(from, from + size).join('\n'), above: from, below: rows.length - from - size };
}
