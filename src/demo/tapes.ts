// `npm run tapes`: writes each GIF scene of scenes.ts as a vhs tape, to
// docs/media/tapes/<name>.tape, and `npm run media:vhs` then records each
// with vhs into docs/media/<name>.gif.
// vhs needs ttyd, ffmpeg and a Chromium on the PATH. In an L2 run's
// container they are out of reach (vhs and ttyd ship only as GitHub release
// assets, which the egress proxy denies), so there the headless recorder
// (record.ts) draws the media instead: see docs/media/README.md.
// Plain .ts (no JSX) so Node runs it without a build step.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GIFS } from './scenes.ts';
import { tape } from './tape.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const TAPES = join('docs', 'media', 'tapes');

const record = process.argv.includes('--record');
await mkdir(join(ROOT, TAPES), { recursive: true });
for (const scene of GIFS) {
  const path = join(TAPES, `${scene.name}.tape`);
  await writeFile(join(ROOT, path), tape(scene));
  console.log(path);
  if (!record) continue;
  const vhs = spawnSync('vhs', [path], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (vhs.error || vhs.status !== 0) {
    console.error(vhs.error ? `vhs didn't start: ${vhs.error.message}. Is it on the PATH, with ttyd and ffmpeg?` : `vhs failed on ${path}.`);
    process.exit(1);
  }
}
