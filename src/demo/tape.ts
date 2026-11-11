// A GIF scene as a vhs tape: it starts `npm run demo` in vhs's terminal,
// out of shot, and types the scene's keys into it at the scene's pace. The
// demo's connection answers them as the daemon would, so the same steps
// play here and in the headless recorder (record.ts).
import { SCHEME } from './draw.ts';
import { BEAT_MS, KEY_GAP_MS, OPENING_MS, type Key, type Scene, type Step } from './stage.ts';

// The terminal vhs draws: about the scenes' 120 columns by 34 rows.
const FONT_SIZE = 14;
const WIDTH = 1060;
const HEIGHT = 640;
const PADDING = 16;
// How long the demo gets to start, out of shot.
const STARTUP = '3s';

// The Windows Terminal scheme (docs/windows-terminal-scheme.md), in the
// keys xterm.js takes.
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const THEME = {
  name: 'agents-factory',
  ...Object.fromEntries(SCHEME.ansi.map((hex, i) => [i < 8 ? ANSI_NAMES[i]! : `bright${ANSI_NAMES[i - 8]![0]!.toUpperCase()}${ANSI_NAMES[i - 8]!.slice(1)}`, hex])),
  background: SCHEME.background,
  foreground: SCHEME.foreground,
  cursor: '#9fce7e',
  selectionBackground: '#333333',
};

// A string as vhs reads it, in quotes it doesn't hold.
function quoted(text: string): string {
  const quote = ['"', "'", '`'].find((mark) => !text.includes(mark));
  if (!quote) throw new Error(`vhs can't type ${text}: it holds every kind of quote`);
  return `${quote}${text}${quote}`;
}

const keyCommand = (key: Key): string => (typeof key === 'string' ? `Type ${quoted(key)}` : key.vhs);

function stepCommands(step: Step): string[] {
  if ('press' in step) return [...step.press.flatMap((key, i) => (i > 0 ? [`Sleep ${KEY_GAP_MS}ms`, keyCommand(key)] : [keyCommand(key)])), `Sleep ${BEAT_MS}ms`];
  if ('text' in step) return [`Type@${step.pace}ms ${quoted(step.text)}`];
  if ('hold' in step) return [`Sleep ${step.hold}ms`];
  return [`Screenshot docs/media/${step.still}.png`];
}

// Sleeps in a row as one.
function mergingSleeps(commands: string[]): string[] {
  const merged: string[] = [];
  for (const command of commands) {
    const [last, next] = [merged.at(-1), command].map((line) => /^Sleep (\d+)ms$/.exec(line ?? '')?.[1]);
    if (last !== undefined && next !== undefined) merged[merged.length - 1] = `Sleep ${Number(last) + Number(next)}ms`;
    else merged.push(command);
  }
  return merged;
}

export function tape(scene: Scene): string {
  return [
    `# Written by \`npm run tapes\` from the ${scene.name} scene in src/demo/scenes.ts:`,
    '# change the scene, not this tape. `npm run media:vhs` records it.',
    `Output docs/media/${scene.name}.gif`,
    '',
    'Require node',
    '',
    `Set FontSize ${FONT_SIZE}`,
    `Set Width ${WIDTH}`,
    `Set Height ${HEIGHT}`,
    `Set Padding ${PADDING}`,
    `Set Theme ${JSON.stringify(THEME)}`,
    // The design system's hex colours, not the 16 the theme maps.
    'Env FORCE_COLOR "3"',
    '',
    'Hide',
    'Type "node src/demo/demo.ts"',
    'Enter',
    `Sleep ${STARTUP}`,
    'Show',
    ...mergingSleeps([`Sleep ${OPENING_MS}ms`, ...scene.steps.flatMap(stepCommands)]),
    'Hide',
    'Ctrl+C',
    '',
  ].join('\n');
}

