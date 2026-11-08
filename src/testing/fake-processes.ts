import type { Clock } from '../daemon/clock.ts';
import { treeOf, type AwakeBlock, type CliProcess, type Processes } from '../os/processes.ts';

// A scripted OS: a table of processes a test starts and ends, each run's
// job, and the idle-sleep blocks held. Each process is created at the
// clock's time, a millisecond after the last at least, and keeps its
// parent's PID once that parent exits, as on Windows. A process started by
// one in a job is in that job too, as with a job that allows no breakaway.
export class FakeProcesses implements Processes {
  private readonly table = new Map<number, { parentPid: number; createdAt: number; job: string | null }>();
  private readonly blocks = new Set<AwakeBlock>();
  private nextPid = 4_000;
  private lastCreated = 0;
  private holdFails = false;

  constructor(private readonly clock: Clock) {}

  // Starts a process, a child of `parentPid` if given, with a new PID or `pid`
  // once that PID is free again.
  spawn(parentPid = 1, pid = this.nextPid++): CliProcess {
    if (this.table.has(pid)) throw new Error(`PID ${pid} is taken.`);
    const createdAt = (this.lastCreated = Math.max(this.clock.now(), this.lastCreated + 1));
    this.table.set(pid, { parentPid, createdAt, job: this.table.get(parentPid)?.job ?? null });
    return { pid, createdAt };
  }

  exit(pid: number): void {
    this.table.delete(pid);
  }

  isAlive(pid: number): boolean {
    return this.table.has(pid);
  }

  sleepBlocked(): boolean {
    return this.blocks.size > 0;
  }

  async adopt(runId: string, pid: number): Promise<void> {
    const listed = this.table.get(pid);
    if (listed) listed.job = runId;
  }

  async sweep(runId: string, cli: CliProcess | null): Promise<void> {
    for (const [pid, { job }] of this.table) if (job === runId) this.exit(pid);
    if (!cli) return;
    const listing = [...this.table].map(([pid, { parentPid, createdAt }]) => ({ pid, parentPid, createdAt }));
    for (const pid of treeOf(cli, listing)) this.exit(pid);
  }

  // The next idle-sleep block asked for can't be had.
  failNextHold(): void {
    this.holdFails = true;
  }

  async holdAwake(): Promise<AwakeBlock> {
    if (this.holdFails) {
      this.holdFails = false;
      throw new Error('The keep-awake helper failed.');
    }
    const block = { release: () => void this.blocks.delete(block) };
    this.blocks.add(block);
    return block;
  }
}
