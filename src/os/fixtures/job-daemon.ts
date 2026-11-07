// Stands in for the daemon: starts a CLI stand-in and, unless `--no-job`,
// assigns it to the kill-on-close job right after spawn.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKillOnCloseJobs } from '../job-object.ts';

const [pidDir, mode] = process.argv.slice(2);
const jobs = mode === '--no-job' ? undefined : await openKillOnCloseJobs();
const cli = spawn(process.execPath, [fileURLToPath(new URL('./process-tree.ts', import.meta.url)), pidDir!, 'cli'], {
  stdio: 'ignore',
  windowsHide: true,
});
await jobs?.assign('R1', cli.pid!);
writeFileSync(join(pidDir!, 'daemon.json'), JSON.stringify({ daemon: process.pid, helper: jobs?.pid }));
setInterval(() => {}, 60_000);
