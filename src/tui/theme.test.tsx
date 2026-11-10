// The theme module: the design system's colours as roles, the 16-colour
// table, the state glyphs, and monochrome without colour.
import chalk from 'chalk';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { ROLES, stateLook, tone } from './theme.ts';

const withLevel = (level: 0 | 1 | 2 | 3) => {
  const was = chalk.level;
  chalk.level = level;
  onTestFinished(() => void (chalk.level = was));
};

afterEach(() => vi.unstubAllEnvs());

describe('colour roles', () => {
  test('each role has the design system’s hex and its 16-colour name', () => {
    expect(ROLES).toEqual({
      fg: { hex: '#ffffff', ansi: 'white', source: expect.any(String) },
      dim: { hex: '#999999', ansi: 'gray', source: expect.any(String) },
      accent: { hex: '#9fce7e', ansi: 'greenBright', source: expect.any(String) },
      ok: { hex: '#53c67d', ansi: 'green', source: expect.any(String) },
      warn: { hex: '#fab338', ansi: 'yellow', source: expect.any(String) },
      bad: { hex: '#f07575', ansi: 'red', source: expect.any(String) },
      review: { hex: '#d28c79', ansi: 'magenta', source: expect.any(String) },
      line: { hex: '#333333', ansi: 'gray', source: expect.any(String) },
    });
  });

  test('a truecolour terminal gets the hex, a lesser one the 16-colour name', () => {
    withLevel(3);
    expect(tone('accent')).toEqual({ color: '#9fce7e' });
    withLevel(2);
    expect(tone('accent')).toEqual({ color: 'greenBright' });
    withLevel(1);
    expect(tone('review')).toEqual({ color: 'magenta' });
  });

  test('under NO_COLOR, or with no colour at all, nothing is coloured and dim text is dimmed', () => {
    withLevel(3);
    vi.stubEnv('NO_COLOR', '1');
    expect(tone('accent')).toEqual({});
    expect(tone('dim')).toEqual({ dimColor: true });
    vi.unstubAllEnvs();
    withLevel(0);
    expect(tone('warn')).toEqual({});
  });

  test('NO_COLOR renders text with no colour escapes', () => {
    withLevel(3);
    vi.stubEnv('NO_COLOR', '1');
    const { lastFrame, unmount } = render(<Text {...tone('bad')}>refused</Text>);
    expect(lastFrame()).toBe('refused');
    unmount();
  });
});

describe('state glyphs', () => {
  test.each([
    ['Running', '●', 'ok'],
    ['Needs you', '!', 'warn'],
    ['In review', '◎', 'review'],
    ['Ready for you', '◆', 'accent'],
    ['In conversation', '◇', 'accent'],
    ['Queued', '⋯', 'dim'],
    ['Waiting on children', '⧗', 'dim'],
    ['Done', '✓', 'dim'],
    ['Cancelled', '✕', 'dim'],
    ['Draft', '○', 'dim'],
  ])('%s shows %s in %s', (label, glyph, role) => {
    expect(stateLook(label)).toMatchObject({ glyph, role });
  });

  test('only a cancelled task is struck through', () => {
    expect(stateLook('Cancelled').strike).toBe(true);
    expect(stateLook('Done').strike).toBe(false);
  });
});
