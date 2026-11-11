// The vhs tapes: what each step becomes, and the committed tapes still the
// scenes' own, so `npm run media:vhs` records what the headless recorder does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { GIFS } from './scenes.ts';
import { CTRL_N, ENTER, type Scene } from './stage.ts';
import { tape } from './tape.ts';

const commands = (scene: Scene) => tape(scene).split('\n').filter((line) => line !== '' && !line.startsWith('#'));

describe('a scene as a vhs tape', () => {
  test('starts the demo out of shot, plays the steps at their pace, and quits out of shot', () => {
    const scene: Scene = { name: 'sample', columns: 120, rows: 34, steps: [{ press: [ENTER, 'n'] }, { text: 'Say "hi"', pace: 90 }, { hold: 500 }, { press: [CTRL_N] }] };
    const lines = commands(scene);
    expect(lines[0]).toBe('Output docs/media/sample.gif');
    expect(lines).toContain('Env FORCE_COLOR "3"');
    expect(lines.slice(lines.indexOf('Hide'))).toEqual([
      'Hide',
      'Type "node src/demo/demo.ts"',
      'Enter',
      'Sleep 3s',
      'Show',
      'Sleep 1500ms',
      'Enter',
      'Sleep 300ms',
      'Type "n"',
      'Sleep 1200ms',
      // Text in quotes it doesn't hold, then the hold and the beat merged.
      `Type@90ms 'Say "hi"'`,
      'Sleep 500ms',
      'Ctrl+N',
      'Sleep 1200ms',
      'Hide',
      'Ctrl+C',
    ]);
  });

  test('the theme is the Windows Terminal scheme’s', () => {
    const theme = JSON.parse(commands(GIFS[0]!).find((line) => line.startsWith('Set Theme '))!.slice('Set Theme '.length));
    expect(theme).toMatchObject({ background: '#1a1a1a', foreground: '#ffffff', green: '#53c67d', brightGreen: '#9fce7e', magenta: '#d28c79', cursor: '#9fce7e' });
  });

  test.each(GIFS.map((scene) => scene.name))('the committed %s tape is the scene’s: run `npm run tapes` after changing it', (name) => {
    const committed = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'media', 'tapes', `${name}.tape`), 'utf8');
    expect(committed).toBe(tape(GIFS.find((scene) => scene.name === name)!));
  });
});
