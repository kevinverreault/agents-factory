// The OS process port's contract, shared by the fake and the Windows adapter
// so the two can't drift apart (ADR 0003).
import { describe, expect, test } from 'vitest';
import type { CliProcess, Processes } from './processes.ts';

export type ProcessesFixture = {
  processes: Processes;
  // Starts a CLI stand-in for the run, adopted right after spawn as the
  // executor does, which then starts one tool through a shell and one
  // detached, as Claude Code starts MCP servers and shells.
  startRunTree(runId: string): Promise<{ cli: CliProcess; tools: number[] }>;
  // Starts a process outside every run's tree.
  startStranger(): Promise<number>;
  // The CLI exits on its own, and its shell with it, leaving its tools behind.
  exitCli(cli: CliProcess): Promise<void>;
  isAlive(pid: number): boolean;
  // Waits until none of `pids` is alive, or throws.
  untilDead(pids: number[]): Promise<void>;
  // Whether the machine is blocked from idle sleep now, and waits until it is or isn't.
  untilSleepBlocked(blocked: boolean): Promise<void>;
  dispose(): Promise<void>;
};

export function describeProcessesContract(name: string, makeFixture: () => Promise<ProcessesFixture>): void {
  async function withFixture(body: (fixture: ProcessesFixture) => Promise<void>): Promise<void> {
    const fixture = await makeFixture();
    try {
      await body(fixture);
    } finally {
      await fixture.dispose();
    }
  }

  describe(`${name}: the OS process contract`, () => {
    test('a sweep kills the CLI and every tool it started, through a shell or detached, and nothing else', () =>
      withFixture(async ({ processes, startRunTree, startStranger, isAlive, untilDead }) => {
        const { cli, tools } = await startRunTree('R1');
        const stranger = await startStranger();

        await processes.sweep('R1', cli);

        await untilDead([cli.pid, ...tools]);
        expect(isAlive(stranger)).toBe(true);
      }));

    test('a sweep finds the tools of a CLI that already exited', () =>
      withFixture(async ({ processes, startRunTree, exitCli, isAlive, untilDead }) => {
        const { cli, tools } = await startRunTree('R1');
        await exitCli(cli);
        expect(tools.filter(isAlive)).toEqual(tools);

        await processes.sweep('R1', cli);

        await untilDead(tools);
      }));

    test('a sweep of a run another daemon started finds the tools a CLI still running started', () =>
      withFixture(async ({ processes, startRunTree, untilDead }) => {
        const { cli, tools } = await startRunTree('R1');

        // This daemon adopted no CLI for R2: the walk alone finds its tree.
        await processes.sweep('R2', cli);

        await untilDead([cli.pid, ...tools]);
      }));

    test('a sweep never matches a reused PID: the process holding it now, and its children, were started after the CLI recorded', () =>
      withFixture(async ({ processes, startRunTree, isAlive }) => {
        const { cli, tools } = await startRunTree('R1');
        // The record is of an earlier process with the same PID, of a run
        // another daemon started: the one holding it now, and every child
        // it started, came after that one's children.
        const earlier = { pid: cli.pid, createdAt: cli.createdAt - 60_000 };

        await processes.sweep('R2', earlier);

        expect([cli.pid, ...tools].filter(isAlive)).toEqual([cli.pid, ...tools]);
      }));

    test('the machine is kept from idle sleep while a block is held, and may sleep once it is released', () =>
      withFixture(async ({ processes, untilSleepBlocked }) => {
        const block = await processes.holdAwake();
        await untilSleepBlocked(true);

        block.release();

        await untilSleepBlocked(false);
      }));
  });
}
