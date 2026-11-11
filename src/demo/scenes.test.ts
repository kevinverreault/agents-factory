// The README's scenes still play as their media show, on the TUI as it is
// now: a key or screen that changed fails here, not in a stale GIF.
import { describe, expect, test } from 'vitest';
import { GIFS, STILLS } from './scenes.ts';
import { play, type Scene } from './stage.ts';

const plain = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '');
const scene = (name: string): Scene => [...GIFS, ...STILLS].find((scene) => scene.name === name)!;

// Each scene's moments, in the order its frames come to them.
const MOMENTS: Record<string, RegExp[]> = {
  'tasks-and-launch': [/LIVE OUTPUT · T2 · R2/, /QUICK LAUNCH[\s\S]*Add a --dry-run flag to sync\.▏/, /QUICK LAUNCH T10[\s\S]*\[1\] Yes, as a diff/, /A diff it is\./],
  'needs-you': [/› question\s+T5/, /digits answer · esc back/, /› review\s+T6[\s\S]*REVIEW/, /› your turn\s+T7/],
  'task-detail': [/Tasks › T2 Add a status --json flag/, /CONVERSATION[\s\S]*The agent is waiting on you\./, /› Only 5xx and timeouts\. Never 4xx\.▏/, /◆ Settled: 5xx and timeouts retry/],
  handoff: [/The agent proposes advancing/, /ADVANCE T1 FROM GRILL/, /› \/handoff▏/, /The agent is writing the brief…/, /› Goal\s+Failed webhook deliveries/, /AFK L1 · claude-opus-5-5 · sonnet · Queued/],
};

describe('the README’s scenes', () => {
  test.each(GIFS.map((gif) => gif.name))('%s comes to each of its moments, in order', async (name) => {
    const { frames } = await play(scene(name));
    let at = 0;
    for (const moment of MOMENTS[name]!) {
      const found = frames.findIndex((frame, i) => i >= at && moment.test(plain(frame.text)));
      expect(found, `${name}: ${moment}`).toBeGreaterThanOrEqual(0);
      at = found;
    }
  }, 30_000);

  test('the stills are of the four screens and the condensed view', async () => {
    const { stills } = await play(scene('screens'));
    const headed = Object.fromEntries(stills.map(({ name, text }) => [name, plain(text).split('\n')[2]!.trim()]));
    expect(headed).toEqual({ tasks: 'Tasks · group: all', 'needs-you': 'Needs you', runs: 'Runs', usage: 'Usage', condensed: 'Condensed · group: all' });
  }, 30_000);
});
