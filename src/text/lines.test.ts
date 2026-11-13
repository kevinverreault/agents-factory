import { describe, expect, test } from 'vitest';
import { cutToFit, lineBreaks, oneLineOf, wordsWithin, wrapped } from './lines.ts';

describe('text of several lines', () => {
  test('lineBreaks makes every line break \\n', () => {
    expect(lineBreaks('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  test('wrapped breaks a line after its last space that fits, keeping every character', () => {
    expect(wrapped('add a logout button', 10)).toEqual(['add a ', 'logout ', 'button']);
    expect(wrapped('Supercalifragilistic', 8)).toEqual(['Supercal', 'ifragili', 'stic']);
    expect(wrapped('', 8)).toEqual(['']);
    expect(wrapped('a😀b', 2)).toEqual(['a😀', 'b']);
  });
});

describe('fitting a line', () => {
  test('oneLineOf collapses whitespace and trims', () => {
    expect(oneLineOf('  Name tasks,\n  branches  ')).toBe('Name tasks, branches');
  });

  test('cutToFit cuts with an ellipsis, only when too long', () => {
    expect(cutToFit('Add a logout button', 72)).toBe('Add a logout button');
    expect(cutToFit('Add a logout button', 10)).toBe('Add a log…');
  });

  test('wordsWithin cuts after the last whole word, dropping trailing punctuation', () => {
    expect(wordsWithin('Add a logout button', 72)).toBe('Add a logout button');
    expect(wordsWithin('Add a logout, button', 14)).toBe('Add a logout');
    expect(wordsWithin('Supercalifragilistic', 5)).toBe('Super');
  });
});
