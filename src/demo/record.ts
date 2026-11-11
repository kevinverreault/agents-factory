// `npm run media`: plays every scene of scenes.ts on the real TUI, headless,
// and writes the README's media to docs/media: a GIF a scene, and a PNG a
// still. Nothing runs but this process: no daemon, terminal, GitHub or
// Claude. `npm run media -- <name>…` plays only the scenes named, and
// `-- --text` prints each scene's frames as text instead of drawing them.
// It stands in for vhs, which needs ttyd, ffmpeg and a browser: the media
// were first recorded where only the npm registry could be reached, and
// this needs nothing more.
// Plain .ts (no JSX) so Node runs it without a build step.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import gifenc from 'gifenc';
import { drawFrame, SCHEME } from './draw.ts';
import { GIFS, STILLS } from './scenes.ts';
import { play, type Frame, type Scene } from './stage.ts';
import { parseFrame, plainText } from './terminal-frame.ts';

// Times show in the machine's zone, and colours only on a terminal: the
// media pin both, in truecolour as Windows Terminal shows them.
process.env.TZ = 'UTC';
delete process.env.NO_COLOR;
chalk.level = 3;

const MEDIA = join(import.meta.dirname, '..', '..', 'docs', 'media');
// The most colours a GIF keeps: the theme's, and their anti-aliased edges.
const COLOURS = 128;
// How many frames, spread through a scene, its palette is drawn from.
const PALETTE_FRAMES = 8;

const args = process.argv.slice(2);
const asText = args.includes('--text');
const named = args.filter((arg) => !arg.startsWith('--'));
const sceneNames = [...GIFS, ...STILLS].map((scene) => scene.name);
const unknown = named.filter((name) => !sceneNames.includes(name));
if (unknown.length > 0) {
  console.error(`No scene named ${unknown.join(', ')}. The scenes: ${sceneNames.join(', ')}.`);
  process.exit(1);
}
const chosen = (scenes: Scene[]) => scenes.filter((scene) => named.length === 0 || named.includes(scene.name));

await mkdir(MEDIA, { recursive: true });
for (const scene of chosen(GIFS)) {
  const { frames } = await play(scene);
  if (asText) printFrames(scene, frames);
  else await writeGif(join(MEDIA, `${scene.name}.gif`), scene, frames);
}
for (const scene of chosen(STILLS)) {
  const { stills } = await play(scene);
  for (const still of stills) {
    if (asText) printFrames({ ...scene, name: still.name }, [{ text: still.text, ms: 0 }]);
    else {
      await writeFile(join(MEDIA, `${still.name}.png`), await drawFrame(still.text, scene.columns, Math.min(scene.rows, linesOf(still.text))).encode('png'));
      console.log(`docs/media/${still.name}.png`);
    }
  }
}

async function writeGif(path: string, scene: Scene, frames: Frame[]): Promise<void> {
  const rgbaOf = (frame: Frame) => {
    const canvas = drawFrame(frame.text, scene.columns, scene.rows);
    return { width: canvas.width, height: canvas.height, rgba: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data };
  };
  // One palette for every frame, from a few of them spread through the
  // scene, and one more index for “as the frame before”: a frame then
  // carries only what changed, which keeps the GIF small.
  const step = Math.max(1, Math.ceil(frames.length / PALETTE_FRAMES));
  const sampled = frames.filter((_, i) => i % step === 0 || i === frames.length - 1).map((frame) => rgbaOf(frame).rgba);
  const pixels = new Uint8ClampedArray(sampled.reduce((total, rgba) => total + rgba.length, 0));
  let at = 0;
  for (const rgba of sampled) {
    pixels.set(rgba, at);
    at += rgba.length;
  }
  const palette = gifenc.quantize(pixels, COLOURS - 1);
  const unchanged = palette.length;
  // Its colour is never matched: frames are mapped onto the palette without it.
  const withUnchanged = [...palette, [255, 0, 255]];
  const gif = gifenc.GIFEncoder();
  let before: Uint8ClampedArray | null = null;
  for (const frame of frames) {
    const { width, height, rgba } = rgbaOf(frame);
    const index = gifenc.applyPalette(rgba, palette);
    if (before) {
      for (let pixel = 0; pixel < index.length; pixel++) {
        const at = pixel * 4;
        if (rgba[at] === before[at] && rgba[at + 1] === before[at + 1] && rgba[at + 2] === before[at + 2]) index[pixel] = unchanged;
      }
    }
    gif.writeFrame(index, width, height, { palette: withUnchanged, delay: frame.ms, repeat: 0, transparent: before !== null, transparentIndex: unchanged, dispose: 1 });
    before = rgba;
  }
  gif.finish();
  await writeFile(path, gif.bytes());
  const seconds = frames.reduce((total, frame) => total + frame.ms, 0) / 1000;
  console.log(`docs/media/${scene.name}.gif: ${frames.length} frames, ${seconds.toFixed(1)} s`);
}

// A still is as tall as what the screen shows: its blank rows below, with
// nothing drawn and no background, are left out.
function linesOf(text: string): number {
  return parseFrame(text, SCHEME).findLastIndex((row) => row.some((cell) => cell.char !== ' ' || cell.bg !== null)) + 1;
}

function printFrames(scene: Scene, frames: Frame[]): void {
  for (const [i, frame] of frames.entries()) {
    console.log(`── ${scene.name} ${i + 1}/${frames.length} · ${frame.ms} ms ──`);
    console.log(plainText(frame.text).split('\n').slice(0, scene.rows).join('\n'));
  }
}
