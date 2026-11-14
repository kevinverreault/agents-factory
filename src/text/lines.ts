// Fitting text on one line: what a task title, a PR title and a model's
// answer are cut to. And text of several lines: its line breaks, and its
// lines wrapped to a width.

// Line breaks as \n, however a terminal, a paste or an editor sent them.
export function lineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// `line` as the rows it takes `width` columns wide: each broken after its
// last space that fits, or at `width` when none does. Every character stays,
// spaces at the breaks included, so the rows join back into the line. One
// column a character: a wide one takes more than its share.
export function wrapped(line: string, width: number): string[] {
  const rows: string[] = [];
  let rest = Array.from(line);
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width - 1);
    const cut = space > 0 ? space + 1 : width;
    rows.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  rows.push(rest.join(''));
  return rows;
}

// Words as a list ending in `or`: `a, b or c`, or the one word alone.
export function orList(words: readonly string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : (words[0] ?? '');
}

// The text on one line: its runs of whitespace one space, its ends trimmed.
export function oneLineOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// `line` within `length`, cut with an ellipsis when longer.
export function cutToFit(line: string, length: number): string {
  return line.length > length ? `${line.slice(0, length - 1).trimEnd()}…` : line;
}

// `line` within `length`, cut after its last whole word that fits, with no
// ellipsis: a word longer than `length` alone is cut at it.
export function wordsWithin(line: string, length: number): string {
  if (line.length <= length) return line;
  const space = line.slice(0, length + 1).lastIndexOf(' ');
  return (space > 0 ? line.slice(0, space) : line.slice(0, length)).replace(/[\s,;:–—-]+$/, '');
}
