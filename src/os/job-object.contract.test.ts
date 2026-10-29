// Seam 3: the kill-on-close job helper takes a run's whole process tree down
// when the daemon dies, nested inside libuv's own jobs (ADR 0003).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { roles } from './fixtures/process-tree.ts';
import { isAlive, waitFor } from './test-support.ts';

const jobDaemon = fileURLToPath(new URL('./fixtures/job-daemon.ts', import.meta.url));
const leftovers: number[] = [];

afterEach(() => {
  for (const pid of leftovers.splice(0)) if (isAlive(pid)) process.kill(pid);
});

// Starts the daemon stand-in, waits for the run's tree, then kills the daemon
// the way a crash does: no graceful stop, no tree kill.
async function crashDaemonWithRunTree(mode: '--job' | '--no-job') {
  const pidDir = mkdtempSync(join(tmpdir(), 'factory-job-'));
  spawn(process.execPath, [jobDaemon, pidDir, mode], { stdio: 'ignore', windowsHide: true });
  const ready = ['daemon.json', ...roles.map((role) => `${role}.pid`)];
  await waitFor(() => ready.every((name) => existsSync(join(pidDir, name))), 30_000);
  const daemon: { daemon: number; helper?: number } = JSON.parse(readFileSync(join(pidDir, 'daemon.json'), 'utf8'));
  const [cli, shellTool, detachedTool] = roles.map((role) => Number(readFileSync(join(pidDir, `${role}.pid`), 'utf8')));
  const tree = { cli: cli!, shellTool: shellTool!, detachedTool: detachedTool! };
  leftovers.push(daemon.daemon, ...Object.values(tree));

  execFileSync('taskkill.exe', ['/F', '/PID', String(daemon.daemon)], { stdio: 'ignore' });
  await waitFor(() => !isAlive(daemon.daemon), 10_000);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return { tree, helper: daemon.helper };
}

describe('kill-on-close job helper on Windows', () => {
  test('a daemon crash takes the CLI and every tool it started down, through a shell or detached', async () => {
    const { tree, helper } = await crashDaemonWithRunTree('--job');

    expect(isAlive(helper!)).toBe(false);
    expect(Object.values(tree).filter(isAlive)).toEqual([]);
  });

  test('without the job, the CLI dies with the daemon but tools started through a shell or detached are orphaned', async () => {
    const { tree } = await crashDaemonWithRunTree('--no-job');

    expect(isAlive(tree.cli)).toBe(false);
    expect(isAlive(tree.shellTool)).toBe(true);
    expect(isAlive(tree.detachedTool)).toBe(true);
  });
});
