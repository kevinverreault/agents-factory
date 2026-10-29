// Seam 3: the real daemon process, auto-started detached by a TUI, and the
// `daemon status` and `daemon stop` commands from a shell.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { isAlive } from '../os/test-support.ts';
import { connectOrStart } from './auto-start.ts';
import { factoryPaths } from './paths.ts';

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await factoryCli(home, 'daemon', 'stop').catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
  delete process.env.AGENTS_FACTORY_HOME;
});

async function factoryCli(home: string, ...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENTS_FACTORY_HOME: home },
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; code: number };
    return { stdout: failed.stdout, code: failed.code };
  }
}

describe('the daemon process', () => {
  test('a TUI with no daemon running starts one detached, and closing the TUI leaves it running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-daemon-'));
    homes.push(home);
    process.env.AGENTS_FACTORY_HOME = home;

    const tui = await connectOrStart(factoryPaths());
    const status = await tui.send({ type: 'daemon.status' });
    tui.close();
    const pid = (status as { value: { pid: number } }).value.pid;

    expect(pid).not.toBe(process.pid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(pid)).toBe(true);
    const shown = await factoryCli(home, 'daemon', 'status');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(`The daemon is running (pid ${pid}, protocol 1)`);
    expect(shown.stdout).toContain('0 TUIs attached');

    expect((await factoryCli(home, 'daemon', 'stop')).stdout).toContain('The daemon stopped.');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(pid)).toBe(false);
    expect(await factoryCli(home, 'daemon', 'status')).toEqual({ stdout: 'The daemon is not running.\n', code: 3 });
  });
});
