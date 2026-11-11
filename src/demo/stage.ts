// Plays a scene on the real TUI, headless: the App on the demo factory's
// connection, in a terminal of a fixed size, its keys pressed and its text
// typed as the scene's steps say. The demo's connection answers the
// commands they send as the daemon would, so a scene is nothing but input:
// the same steps vhs types (tapes.ts). What comes out is the frames the
// terminal showed, each with how long it shows: the scene's own timings,
// never the machine's, so a scene plays the same frames every time.
import { createElement as h } from 'react';
import { render } from 'ink-testing-library';
import { App } from '../tui/app.ts';
import { DEMO_CWD, DemoConnection } from './demo-factory.ts';

// A key that types no character: what the terminal sends for it, and its
// name in a vhs tape.
export type NamedKey = { sequence: string; vhs: string };
export const UP: NamedKey = { sequence: '\x1b[A', vhs: 'Up' };
export const DOWN: NamedKey = { sequence: '\x1b[B', vhs: 'Down' };
export const ENTER: NamedKey = { sequence: '\r', vhs: 'Enter' };
export const ESC: NamedKey = { sequence: '\x1b', vhs: 'Escape' };
export const CTRL_B: NamedKey = { sequence: '\x02', vhs: 'Ctrl+B' };
export const CTRL_N: NamedKey = { sequence: '\x0e', vhs: 'Ctrl+N' };
// A named key, or a character's own key.
export type Key = NamedKey | string;

export type Step =
  // Keys pressed KEY_GAP_MS apart, then the beat their result shows for.
  | { press: Key[] }
  // Text typed a character at a time, `pace` ms apart.
  | { text: string; pace: number }
  // The frame on show stays up this much longer.
  | { hold: number }
  // A still of the frame on show, saved as docs/media/<name>.png.
  | { still: string };

export type Scene = { name: string; columns: number; rows: number; steps: Step[] };

export type Frame = { text: string; ms: number };
export type Played = { frames: Frame[]; stills: { name: string; text: string }[] };

// How long the result of a press shows before the next step.
export const BEAT_MS = 1_200;
// Between the keys of one press: a terminal that gets them in one burst
// hands Ink only the first.
export const KEY_GAP_MS = 300;
// How long the TUI shows on its own before the first step.
export const OPENING_MS = 1_500;
// The TUI has taken in a step once its frame holds still this long, in real
// time: Ink throttles its frames and React runs effects on its own
// schedule, so a step can take a few frames to show. It gets at most
// SETTLE_CAP_MS, for a step that changes nothing.
const STILL_FOR_MS = 100;
const POLL_MS = 20;
const SETTLE_CAP_MS = 2_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settled(lastFrame: () => string | undefined): Promise<void> {
  let frame = lastFrame();
  let still = 0;
  for (let waited = 0; still < STILL_FOR_MS && waited < SETTLE_CAP_MS; waited += POLL_MS) {
    await pause(POLL_MS);
    const next = lastFrame();
    still = next === frame ? still + POLL_MS : 0;
    frame = next;
  }
}

export const sequenceOf = (key: Key): string => (typeof key === 'string' ? key : key.sequence);

export async function play(scene: Scene): Promise<Played> {
  const app = render(h(App, { connection: new DemoConnection(), cwd: DEMO_CWD }));
  const stdout = app.stdout as unknown as NodeJS.EventEmitter;
  Object.defineProperty(stdout, 'columns', { value: scene.columns, configurable: true });
  Object.defineProperty(stdout, 'rows', { value: scene.rows, configurable: true });
  stdout.emit('resize');
  const frames: Frame[] = [];
  const stills: Played['stills'] = [];
  const show = (ms: number) => {
    const text = app.lastFrame() ?? '';
    const last = frames.at(-1);
    if (last && last.text === text) last.ms += ms;
    else frames.push({ text, ms });
  };
  // Each key is taken in before the next, as a hand presses them.
  const type = async (sequence: string) => {
    app.stdin.write(sequence);
    await settled(app.lastFrame);
  };
  try {
    await settled(app.lastFrame);
    show(OPENING_MS);
    for (const step of scene.steps) {
      if ('press' in step) {
        for (const [i, key] of step.press.entries()) {
          if (i > 0) show(KEY_GAP_MS);
          await type(sequenceOf(key));
        }
        show(BEAT_MS);
      } else if ('text' in step) {
        for (const char of step.text) {
          await type(char);
          show(step.pace);
        }
      } else if ('hold' in step) show(step.hold);
      else stills.push({ name: step.still, text: app.lastFrame() ?? '' });
    }
  } finally {
    app.unmount();
  }
  return { frames, stills };
}
