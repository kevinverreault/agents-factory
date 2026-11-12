// The TUI's look: the operator's design system as colour roles, the
// 16-colour table for terminals without truecolour, the glyphs each task
// state shows, and the pieces every screen is drawn with (rules, headings,
// key hints, sheets). No screen sets a colour or a glyph of its own.
//
// The TUI is for dark terminals: it colours text and never paints the
// terminal's background. Truecolour terminals (Windows Terminal among them)
// get the hex, others the 16-colour name, and under NO_COLOR, or off a TTY,
// it is monochrome: glyphs, › and bold still tell rows apart.
import { createElement as h, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import type { AttentionKind } from '../lifecycle/lifecycle.ts';

export type Role = 'fg' | 'dim' | 'accent' | 'ok' | 'warn' | 'bad' | 'review' | 'line';
type Ansi = 'white' | 'gray' | 'greenBright' | 'green' | 'yellow' | 'red' | 'magenta' | 'black';
type Colour = { hex: string; ansi: Ansi; source: string };

// The design system (kevinverreault/design-system, src/styles/global.css),
// its dark theme, copied: it isn't a package.
export const ROLES: Record<Role, Colour> = {
  fg: { hex: '#ffffff', ansi: 'white', source: '--color-on-background: 0 0% 100%' },
  // TUI-only: the design system has no muted text. A neutral between its surface and white.
  dim: { hex: '#999999', ansi: 'gray', source: 'TUI-only: hsl(160 0% 60%)' },
  accent: { hex: '#9fce7e', ansi: 'greenBright', source: '--color-accent (sauge): 95 45% 65%' },
  ok: { hex: '#53c67d', ansi: 'green', source: '--color-success: 142 50% 55%' },
  warn: { hex: '#fab338', ansi: 'yellow', source: '--color-warning: 38 95% 60%' },
  bad: { hex: '#f07575', ansi: 'red', source: '--color-error-text: 0 80% 70%' },
  // TUI-only: terracotta (--color-secondary, 13 50% 45%) lifted for dark, as the design system lifts sauge.
  review: { hex: '#d28c79', ansi: 'magenta', source: 'TUI-only: hsl(13 50% 65%)' },
  line: { hex: '#333333', ansi: 'gray', source: '--color-surface: 160 0% 20%' },
};

// What text on an accent fill (the active tab) is in.
export const ON_ACCENT: Colour = { hex: '#1a1a1a', ansi: 'black', source: '--color-background: 160 0% 10%' };

// Whether, and how richly, the terminal takes colour: NO_COLOR turns it
// off, which chalk's own detection doesn't heed.
function level(): number {
  return process.env.NO_COLOR ? 0 : chalk.level;
}

function colour({ hex, ansi }: Colour): string | undefined {
  const at = level();
  return at === 0 ? undefined : at === 3 ? hex : ansi;
}

// A Text's props for a role. Without colour, dim text is dimmed instead.
export function tone(role: Role): { color?: string; dimColor?: boolean } {
  const color = colour(ROLES[role]);
  if (color) return { color };
  return role === 'dim' || role === 'line' ? { dimColor: true } : {};
}

// A Box's border props for a role.
export function border(role: Role): { borderColor?: string; borderDimColor?: boolean } {
  const color = colour(ROLES[role]);
  if (color) return { borderColor: color };
  return role === 'dim' || role === 'line' ? { borderDimColor: true } : {};
}

// The active tab: filled with the accent, or reversed without colour.
export function filled(): { color?: string; backgroundColor?: string; inverse?: boolean } {
  const fill = colour(ROLES.accent);
  return fill ? { color: colour(ON_ACCENT), backgroundColor: fill } : { inverse: true };
}

// How a task's shown state (its label) looks: a glyph and the role its
// glyph and state text are in. Keyed by the labels the lifecycle's label()
// gives, and the factory state's Waiting for window; the theme's tests
// check every one of them has its look here.
export type Look = { glyph: string; role: Role; strike: boolean };
const LOOKS: Record<string, [string, Role]> = {
  Running: ['●', 'ok'],
  'Needs you': ['!', 'warn'],
  'In review': ['◎', 'review'],
  'Ready for you': ['◆', 'accent'],
  'In conversation': ['◇', 'accent'],
  Queued: ['⋯', 'dim'],
  // A HITL task queued until the factory read its map.
  'Reading the map': ['⋯', 'dim'],
  // A run held until the usage window reopens.
  'Waiting for window': ['⋯', 'warn'],
  'Waiting on children': ['⧗', 'dim'],
  Done: ['✓', 'dim'],
  Cancelled: ['✕', 'dim'],
  Draft: ['○', 'dim'],
};

export function stateLook(label: string): Look {
  const [glyph, role] = LOOKS[label] ?? ['·', 'fg'];
  return { glyph, role, strike: label === 'Cancelled' };
}

// What a Needs you item is, as its kind column names it, and the role it
// is lit in: questions and the operator's turn in the accent, what blocks
// work in warn, what failed in bad, and what waits for review in review.
type Item = { kind: 'attention'; attention: AttentionKind } | { kind: 'ready' } | { kind: 'review' };
const KINDS: Record<AttentionKind, [string, Role]> = {
  question: ['question', 'accent'],
  permission: ['permission', 'warn'],
  failure: ['failure', 'bad'],
  'stage-blocked': ['blocked', 'warn'],
  'github-write': ['github', 'bad'],
  'pr-closed-unmerged': ['PR closed', 'warn'],
  'repo-missing': ['repo missing', 'bad'],
  'recovery-report': ['recovered', 'accent'],
};

export function kindLook(item: Item): { kind: string; role: Role } {
  if (item.kind === 'ready') return { kind: 'your turn', role: 'accent' };
  if (item.kind === 'review') return { kind: 'review', role: 'review' };
  const [kind, role] = KINDS[item.attention];
  return { kind, role };
}

export function kindRole(item: Item): Role {
  return kindLook(item).role;
}

// The glyphs the screens share.
export const GLYPH = {
  selected: '›',
  current: '✓',
  live: '●',
  slotTaken: '●',
  slotFree: '○',
  resets: '↻',
  divider: '│',
  rule: '─',
  barFull: '█',
  barEmpty: '░',
  agent: '◆',
  operator: '›',
  system: '·',
  conversation: '◇',
  failed: '✗',
  // The group the condensed view's tree is filtered by.
  marked: '•',
  // Between a breadcrumb's screen and the task drilled into.
  crumb: '›',
  // Between the parts of a line that says what something is.
  between: '·',
  // The end of a line being typed.
  caret: '▏',
  // The stage an advance lands on.
  advances: '←',
  // Around a value ←→ changes.
  chooseBefore: '‹',
  chooseAfter: '›',
  // A section's top corners, as its rounded border has them.
  cornerTopLeft: '╭',
  cornerTopRight: '╮',
  // A box ticked, or not, on a sheet that takes several.
  ticked: '[x]',
  unticked: '[ ]',
  // Where a line broke, on a line that shows it whole.
  newline: '↵',
  // A sparkline's bars, lowest to highest.
  spark: '▁▂▃▄▅▆▇█',
} as const;

// A value ←→ changes, between its markers.
export function choosable(value: string): string {
  return `${GLYPH.chooseBefore} ${value} ${GLYPH.chooseAfter}`;
}

// Parts of a line that says what something is, `·` between them. A part
// something hasn't got (empty, null or undefined) is left out.
export function joined(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(` ${GLYPH.between} `);
}

// A share (0 to 1) as a bar of `cells`.
export function bar(share: number, cells: number): string {
  const full = Math.round(Math.min(Math.max(share, 0), 1) * cells);
  return GLYPH.barFull.repeat(full) + GLYPH.barEmpty.repeat(cells - full);
}

// How full a usage window is: ok below 65%, warn from 65%, bad from 85%.
export function spentRole(share: number): Role {
  return share >= 0.85 ? 'bad' : share >= 0.65 ? 'warn' : 'ok';
}

// The cursor's column: › on the selected row, a space on the others.
export function Cursor({ on }: { on: boolean }) {
  return h(Box, { flexShrink: 0 }, h(Text, tone('accent'), on ? GLYPH.selected : ' '));
}

// A box on a sheet that takes several: ticked in ok, or not, dim.
export function Tick({ on }: { on: boolean }) {
  return h(Text, tone(on ? 'ok' : 'dim'), on ? GLYPH.ticked : GLYPH.unticked);
}

// A full-width rule, or one led by a label in the label's role.
export function Rule({ role = 'line', label }: { role?: Role; label?: string }) {
  const line = h(Box, { flexGrow: 1, borderStyle: 'single', borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, ...border(role) });
  if (label === undefined) return h(Box, { flexShrink: 0 }, line);
  return h(Box, { flexShrink: 0, gap: 1 }, h(Box, { flexShrink: 1 }, h(Text, { ...tone(role), wrap: 'truncate' }, `${GLYPH.rule.repeat(2)} ${label}`)), line);
}

// A section heading: dim and uppercase, or accent on a focused pane.
export function Heading({ text, role = 'dim' }: { text: string; role?: Role }) {
  return h(Text, { ...tone(role), wrap: 'truncate' }, text.toUpperCase());
}

// Key hints: each key bold, what it does dim, `·` between them. They
// wrap onto a second line on a narrow terminal, a hint whole on each, the
// `·` ending the line it breaks rather than starting the next.
export type Hint = [key: string, does: string];
export function Keys({ keys }: { keys: Hint[] }) {
  return h(
    Box,
    { flexWrap: 'wrap', flexShrink: 0 },
    ...keys.map(([key, does], i) =>
      h(
        Text,
        { key: i },
        key ? h(Text, { ...tone('fg'), bold: true }, key) : null,
        does ? h(Text, tone('dim'), key ? ` ${does}` : does) : null,
        i === keys.length - 1 ? null : h(Text, tone('dim'), ' · '),
      ),
    ),
  );
}

// The one style of every sheet, card, picker and prompt: a rounded border
// in the accent, or the kind's role when it is about a request; an
// uppercase title; and a dim key hint at the bottom. It stays whole, unless
// it `shrinks` on a short screen: then what of its content gives way does,
// its title and hint staying.
export function Sheet({ title, role = 'accent', hint, shrinks = false, children }: { title: string; role?: Role; hint?: ReactNode; shrinks?: boolean; children?: ReactNode }) {
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', ...border(role), paddingX: 1, flexShrink: shrinks ? 1 : 0, overflow: shrinks ? 'hidden' : 'visible' },
    h(Box, { flexShrink: 0 }, h(Text, { ...tone(role), bold: true, wrap: 'truncate' }, title.toUpperCase())),
    children,
    hint ? h(Box, { flexDirection: 'column', flexShrink: 0 }, typeof hint === 'string' ? h(Text, tone('dim'), hint) : hint) : null,
  );
}

// A section of a screen in a border of its own, in the line colour, its
// heading on the top edge: `╭─ RUNS ───╮`. `lead` goes before the heading,
// as live output's ●. `size` sizes it as any box: `flexGrow` to take the
// room left, `flexShrink` to give way on a short screen. `bottom` keeps
// its latest lines in view, its content held to the bottom edge.
export function Section({
  title,
  lead,
  bottom = false,
  children,
  ...size
}: {
  title: string;
  lead?: ReactNode;
  bottom?: boolean;
  children?: ReactNode;
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number;
  width?: number;
}) {
  const edge = (text: string) => h(Text, tone('line'), text);
  const line = h(Box, { flexGrow: 1, borderStyle: 'single', borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, ...border('line') });
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0, ...size },
    h(
      Box,
      { flexShrink: 0 },
      edge(`${GLYPH.cornerTopLeft}${GLYPH.rule} `),
      lead ? h(Box, { flexShrink: 0, marginRight: 1 }, lead) : null,
      h(Box, { flexShrink: 1 }, h(Text, { ...tone('dim'), wrap: 'truncate' }, title.toUpperCase())),
      edge(' '),
      line,
      edge(GLYPH.cornerTopRight),
    ),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', justifyContent: bottom ? 'flex-end' : 'flex-start', borderStyle: 'round', borderTop: false, ...border('line'), paddingX: 1 },
      children,
    ),
  );
}

// An option on a sheet: its digit in brackets, in the accent.
export function Option({ digit, children }: { digit: number | string; children?: ReactNode }) {
  return h(Box, { gap: 1 }, h(Text, { ...tone('accent'), bold: true }, `[${digit}]`), h(Box, { flexShrink: 1 }, typeof children === 'string' ? h(Text, null, children) : children));
}
