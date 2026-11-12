import { describe, expect, test } from 'vitest';
import { cutToFit, oneLineOf, wordsWithin } from './lines.ts';

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
