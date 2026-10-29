// Seam 3: the daemon auto-start survives the terminal window that spawned it
// (ADR 0002).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { isAlive, waitFor } from '../os/test-support.ts';
import { terminalProbeFile } from './fixtures/terminal-probe.ts';

const tuiStub = fileURLToPath(new URL('./fixtures/tui-stub.ts', import.meta.url));
const leftovers: number[] = [];

afterEach(() => {
  for (const pid of leftovers.splice(0)) if (isAlive(pid)) process.kill(pid);
});

type Pids = { tui: number; daemon: number };

describe('detached daemon start on Windows', () => {
  test('the daemon outlives a closed console window that spawned it', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'factory-daemon-')), 'pids.json');
    // `start` opens a new console window; the TUI stub then closes it.
    const command = [process.execPath, tuiStub, pidFile, '--close'].map((arg) => `"${arg}"`);
    spawn('cmd.exe', ['/c', 'start', '"factory-skeleton"', ...command], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();

    await waitFor(() => existsSync(pidFile), 20_000);
    const pids: Pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    leftovers.push(pids.tui, pids.daemon);
    await waitFor(() => !isAlive(pids.tui), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(isAlive(pids.daemon)).toBe(true);
  });

  // Needs the operator: run `npm run probe:terminal-close` in Windows Terminal,
  // close that window with its close button, then run this test.
  test.skipIf(!existsSync(terminalProbeFile))(
    'the daemon outlives a closed Windows Terminal window that spawned it',
    () => {
      const pids: Pids = JSON.parse(readFileSync(terminalProbeFile, 'utf8'));
      rmSync(terminalProbeFile);
      leftovers.push(pids.daemon);

      expect(isAlive(pids.tui)).toBe(false);
      expect(isAlive(pids.daemon)).toBe(true);
    },
  );
});
