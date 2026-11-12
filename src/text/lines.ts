// Fitting text on one line: what a task title, a PR title and a model's
// answer are cut to.

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
