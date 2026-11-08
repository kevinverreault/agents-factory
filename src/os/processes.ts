// The OS process port (ADR 0003): sweeps what a run's CLI left behind, and
// keeps the machine awake while AFK work runs. The Windows adapter is the
// real one; the daemon core sees only the port.
import { execFile } from 'node:child_process';
import { openKillOnCloseJobs, type KillOnCloseJobs } from './job-object.ts';
import { holdAwake } from './keep-awake.ts';

// The CLI process the daemon spawned for a run: its PID and when the OS
// created it, in epoch milliseconds.
export type CliProcess = { pid: number; createdAt: number };

// One process in a listing of the machine's: its parent's PID stays what it
// was after the parent exits, and may name a newer process since.
export type ProcessListing = { pid: number; parentPid: number; createdAt: number };

export type AwakeBlock = { release(): void };

export interface Processes {
  // Puts the run's CLI, right after the executor spawned it, into a job of
  // the run's own that takes everything it starts down with it: at the
  // run's sweep, or when the daemon dies. Best effort: a CLI the OS can't
  // put in a job is left to the walk.
  adopt(runId: string, pid: number): Promise<void>;
  // Kills the run's CLI, if it still runs, and every process descended from
  // it: its job's, and those a walk by parent PID finds. A PID reused since
  // the CLI exited is never matched. A run whose CLI never came up has no
  // CLI recorded (`null`): only its job is closed.
  sweep(runId: string, cli: CliProcess | null): Promise<void>;
  // Blocks idle sleep until released. The display may still sleep.
  holdAwake(): Promise<AwakeBlock>;
}

// How far apart two readings of one process's creation time may be: the
// executor's reading is a fallback taken at spawn when the OS can't be asked.
const SAME_PROCESS_MS = 1_000;

// The PIDs of the CLI's process tree in `listing`, the CLI first if it still
// runs. Each process kept is newer than its parent, so a PID reused since
// is never followed. If another process holds the CLI's PID now, only
// children started before it can be the CLI's.
export function treeOf(cli: CliProcess, listing: readonly ProcessListing[]): number[] {
  const holder = listing.find((listed) => listed.pid === cli.pid);
  const stillRuns = holder !== undefined && Math.abs(holder.createdAt - cli.createdAt) < SAME_PROCESS_MS;
  const tree = stillRuns ? [cli.pid] : [];
  const seen = new Set([cli.pid]);
  const visit = (parent: number, from: number, until: number) => {
    for (const child of listing) {
      if (child.parentPid !== parent || seen.has(child.pid) || child.createdAt < from || child.createdAt >= until) continue;
      seen.add(child.pid);
      tree.push(child.pid);
      visit(child.pid, child.createdAt, Infinity);
    }
  };
  visit(cli.pid, cli.createdAt - (stillRuns ? SAME_PROCESS_MS : 0), holder && !stillRuns ? holder.createdAt : Infinity);
  return tree;
}

// Windows: each run's job is a kill-on-close job object, held by a helper
// that starts with the first run; the sweep closes it, then walks
// `Win32_Process` by `ParentProcessId`; the keep-awake block is a helper
// holding `SetThreadExecutionState`. Elsewhere none of it does anything yet.
export function osProcesses(): Processes {
  if (process.platform !== 'win32') return { adopt: async () => {}, sweep: async () => {}, holdAwake: async () => ({ release() {} }) };
  let jobs: Promise<KillOnCloseJobs | null> | null = null;
  return {
    async adopt(runId, pid) {
      jobs ??= openKillOnCloseJobs().catch(() => null);
      await (await jobs)?.assign(runId, pid).catch(() => {});
    },
    async sweep(runId, cli) {
      await (await jobs)?.close(runId).catch(() => {});
      if (!cli) return;
      for (const pid of treeOf(cli, await listProcesses())) {
        try {
          process.kill(pid);
        } catch {
          // It exited meanwhile.
        }
      }
    },
    holdAwake,
  };
}

const LIST_SCRIPT = `Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }
}`;

function listProcesses(): Promise<ProcessListing[]> {
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(
        stdout.split(/\r?\n/).flatMap((line) => {
          const [pid, parentPid, createdAt] = line.trim().split(' ').map(Number);
          return pid && Number.isFinite(parentPid) && createdAt ? [{ pid, parentPid: parentPid!, createdAt }] : [];
        }),
      );
    }),
  );
}
