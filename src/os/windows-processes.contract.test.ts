// Seam 3: the OS process port on Windows (ADR 0003). The descendant sweep
// walks the real process table, and the keep-awake block holds an idle-sleep
// block while it lives.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, test } from 'vitest';
import { roles } from './fixtures/process-tree.ts';
import { holdAwake } from './keep-awake.ts';
import { processCreatedAt } from './process-info.ts';
import { describeProcessesContract } from './processes-contract.ts';
import { osProcesses } from './processes.ts';
import { isAlive, systemSleepBlocked, waitFor } from './test-support.ts';

const processTree = fileURLToPath(new URL('./fixtures/process-tree.ts', import.meta.url));
const leftovers: number[] = [];

function killLeftovers(): void {
  for (const pid of leftovers.splice(0)) if (isAlive(pid)) process.kill(pid);
}

// The idle-sleep readout is system-wide, so the keep-awake checks can't
// tell their block from another process's.
let sleepAlreadyBlocked = false;
beforeAll(() => {
  sleepAlreadyBlocked = systemSleepBlocked();
});

function untilSleepBlocked(blocked: boolean): Promise<void> {
  if (sleepAlreadyBlocked) throw new Error('Another process already blocks idle sleep; close it and rerun.');
  return waitFor(() => systemSleepBlocked() === blocked, 10_000);
}

afterEach(killLeftovers);

describeProcessesContract('the Windows OS', async () => {
  const processes = osProcesses();
  return {
    processes,
    async startRunTree(runId) {
      const pidDir = mkdtempSync(join(tmpdir(), 'factory-sweep-'));
      // The stand-in waits a moment before it starts its tools.
      const cli = spawn(process.execPath, [processTree, pidDir, 'cli'], { stdio: 'ignore', windowsHide: true });
      await processes.adopt(runId, cli.pid!);
      await waitFor(() => roles.every((role) => existsSync(join(pidDir, `${role}.pid`))), 30_000);
      const [pid, ...tools] = roles.map((role) => Number(readFileSync(join(pidDir, `${role}.pid`), 'utf8')));
      leftovers.push(pid!, ...tools);
      return { cli: { pid: pid!, createdAt: await processCreatedAt(pid!) }, tools };
    },
    async startStranger() {
      const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore', windowsHide: true });
      leftovers.push(stranger.pid!);
      return stranger.pid!;
    },
    async exitCli(cli) {
      process.kill(cli.pid);
      await waitFor(() => !isAlive(cli.pid), 10_000);
    },
    isAlive,
    untilDead: (pids) => waitFor(() => !pids.some(isAlive), 10_000),
    untilSleepBlocked,
    async dispose() {
      killLeftovers();
    },
  };
});

describe('keep-awake helper on Windows', () => {
  test('the block ends when its holder dies', async () => {
    const block = await holdAwake();
    await untilSleepBlocked(true);

    process.kill(block.pid);
    await untilSleepBlocked(false);
  });
});
