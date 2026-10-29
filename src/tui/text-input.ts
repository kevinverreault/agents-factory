// One line of text the operator types, edited key by key.
import type { Key } from 'ink';

// The draft after `input`, or null when the key isn't an edit.
export function edit(draft: string, input: string, key: Key): string | null {
  if (key.backspace || key.delete) return draft.slice(0, -1);
  if (key.ctrl || key.meta || key.return || key.tab || key.escape || key.upArrow || key.downArrow) return null;
  if (key.leftArrow || key.rightArrow || !input) return null;
  return draft + input;
}
