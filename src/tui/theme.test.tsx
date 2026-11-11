// The theme module: the design system's colours as roles, the 16-colour
// table, the state glyphs, and monochrome without colour.
import chalk from 'chalk';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { label, type AttentionKind, type Task, type TaskState } from '../lifecycle/lifecycle.ts';
import { kindLook, ROLES, Section, Sheet, stateLook, tone } from './theme.ts';

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

  test('every label a task can have has a glyph of its own, so a renamed label fails here instead of showing uncoloured', () => {
    const states: TaskState[] = ['draft', 'queued', 'running', 'waiting', 'awaiting-children', 'in-review', 'done', 'cancelled'];
    const labels = new Set(['Waiting for window']);
    for (const state of states)
      for (const mode of ['AFK', 'HITL'] as const)
        for (const ready of [false, true]) {
          // A HITL task queued at a work loop over a map waits for the factory to read it.
          for (const preset of [null, { stages: [{ id: 'tickets', kind: 'loop', mode: 'HITL', exit: 'map-cleared' }] }]) {
            labels.add(label({ state, mode, preset, stage: 'tickets', loop: preset ? { step: 'pick' } : null } as unknown as Task, ready));
          }
        }
    expect(labels).toContain('Reading the map');
    for (const shown of labels) expect(stateLook(shown).glyph, shown).not.toBe('·');
  });

  test('only a cancelled task is struck through', () => {
    expect(stateLook('Cancelled').strike).toBe(true);
    expect(stateLook('Done').strike).toBe(false);
  });
});

describe('the sheet style', () => {
  test('a sheet has a rounded border, its title in uppercase, its content, then its key hint', () => {
    const { lastFrame, unmount } = render(
      <Sheet title="Filter by group" hint="enter filters · esc back">
        <Text>All tasks</Text>
      </Sheet>,
    );
    const lines = lastFrame()!.split('\n');
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.slice(1, -1).map((line) => line.replace(/^│\s|\s*│$/g, ''))).toEqual(['FILTER BY GROUP', 'All tasks', 'enter filters · esc back']);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    unmount();
  });

  test('a sheet about a request takes its kind’s colour; any other the accent', () => {
    withLevel(3);
    const border = (role?: 'bad') => {
      const { lastFrame, unmount } = render(<Sheet title="Failure" role={role} />);
      const frame = lastFrame()!;
      unmount();
      return frame;
    };
    // Truecolour escapes: #f07575 is 240;117;117, #9fce7e is 159;206;126.
    expect(border('bad')).toContain('\x1b[38;2;240;117;117m╭');
    expect(border()).toContain('\x1b[38;2;159;206;126m╭');
  });
});

// Every attention kind's name and role: keyed by the kind, so a kind added
// without its look fails the typecheck here.
const ATTENTION_LOOKS = {
  question: ['question', 'accent'],
  permission: ['permission', 'warn'],
  failure: ['failure', 'bad'],
  'stage-blocked': ['blocked', 'warn'],
  'github-write': ['github', 'bad'],
  'pr-closed-unmerged': ['PR closed', 'warn'],
  'repo-missing': ['repo missing', 'bad'],
  'recovery-report': ['recovered', 'accent'],
} as const satisfies Record<AttentionKind, readonly [string, string]>;

describe('Needs you kinds', () => {
  test.each(Object.entries(ATTENTION_LOOKS).map(([attention, [kind, role]]) => [attention as AttentionKind, kind, role]))('a %s request is named %s, in %s', (attention, kind, role) => {
    expect(kindLook({ kind: 'attention', attention })).toEqual({ kind, role });
  });

  test.each([
    ['ready', 'your turn', 'accent'],
    ['review', 'review', 'review'],
  ] as const)('a %s item is named %s, in %s', (item, kind, role) => {
    expect(kindLook({ kind: item })).toEqual({ kind, role });
  });
});

describe('sections', () => {
  test('a section is a border of its own, its heading in uppercase on the top edge, its lead before it', () => {
    const { lastFrame, unmount } = render(
      <Section title="Live output · T2" lead={<Text>●</Text>}>
        <Text>Read the brief</Text>
      </Section>,
    );
    const lines = lastFrame()!.split('\n');
    expect(lines[0]).toMatch(/^╭─ ● LIVE OUTPUT · T2 ─+╮$/);
    expect(lines[1]).toMatch(/^│ Read the brief\s+│$/);
    expect(lines[2]).toMatch(/^╰─+╯$/);
    expect(lines).toHaveLength(3);
    unmount();
  });
});
