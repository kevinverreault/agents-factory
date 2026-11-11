// Plays a scene on the real TUI, headless: the App on the demo factory's
// connection, in a terminal of a fixed size, its keys typed and the daemon's
// patches served as the scene's steps say. What comes out is the frames the
// terminal showed, each with how long it shows: the scene's own timings,
// never the machine's, so a scene plays the same frames every time.
import { createElement as h } from 'react';
import { render } from 'ink-testing-library';
import type { ConversationEvent } from '../executor/executor.ts';
import type { PatchOp } from '../protocol/factory-state.ts';
import { App } from '../tui/app.ts';
import { DEMO_CWD, DemoConnection } from './demo-factory.ts';

export type Step =
  // Keys pressed, each a whole key sequence, shown once all are in.
  | { keys: string[] }
  // Text typed a character at a time, `pace` ms apart, each its own frame.
  | { text: string; pace: number }
  // A change from the daemon.
  | { patch: PatchOp[] }
  // A run's conversation goes on.
  | { converse: string; events: ConversationEvent[] }
  // The frame on show stays up this much longer.
  | { hold: number }
  // A still of the frame on show, saved as docs/media/<name>.png.
  | { still: string };

export type Scene = { name: string; columns: number; rows: number; steps: Step[] };

export type Frame = { text: string; ms: number };
export type Played = { frames: Frame[]; stills: { name: string; text: string }[] };

// How long a step's frame shows when the scene doesn't say.
const BEAT_MS = 400;
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

export async function play(scene: Scene): Promise<Played> {
  const connection = new DemoConnection();
  const app = render(h(App, { connection, cwd: DEMO_CWD }));
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
  const settle = () => settled(app.lastFrame);
  try {
    await settle();
    show(BEAT_MS);
    for (const step of scene.steps) {
      // Each key is taken in before the next, as a hand presses them.
      if ('keys' in step) {
        for (const key of step.keys) {
          app.stdin.write(key);
          await settle();
        }
        show(BEAT_MS);
      } else if ('text' in step) {
        for (const char of step.text) {
          app.stdin.write(char);
          await settle();
          show(step.pace);
        }
      } else if ('patch' in step) {
        connection.servePatch(step.patch);
        await settle();
        show(BEAT_MS);
      } else if ('converse' in step) {
        connection.serveConversation(step.converse, ...step.events);
        await settle();
        show(BEAT_MS);
      } else if ('hold' in step) show(step.hold);
      else stills.push({ name: step.still, text: app.lastFrame() ?? '' });
    }
  } finally {
    app.unmount();
  }
  return { frames, stills };
}
