import { describeProcessesContract } from '../os/processes-contract.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeProcesses } from './fake-processes.ts';

describeProcessesContract('the fake OS', async () => {
  const clock = new FakeClock();
  const processes = new FakeProcesses(clock);
  // Each CLI's shell, which libuv kills with it.
  const shells = new Map<number, number>();
  const untilTrue = async (condition: () => boolean) => {
    if (!condition()) throw new Error('The fake OS should have settled at once.');
  };
  return {
    processes,
    async startRunTree(runId) {
      const cli = processes.spawn();
      await processes.adopt(runId, cli.pid);
      clock.advance(1_500);
      // Through a shell, which waits for the tool.
      const shell = processes.spawn(cli.pid);
      shells.set(cli.pid, shell.pid);
      const shellTool = processes.spawn(shell.pid);
      const detachedTool = processes.spawn(cli.pid);
      return { cli, tools: [shellTool.pid, detachedTool.pid] };
    },
    async startStranger() {
      return processes.spawn().pid;
    },
    async exitCli(cli) {
      processes.exit(cli.pid);
      processes.exit(shells.get(cli.pid)!);
    },
    isAlive: (pid) => processes.isAlive(pid),
    untilDead: (pids) => untilTrue(() => !pids.some((pid) => processes.isAlive(pid))),
    untilSleepBlocked: (blocked) => untilTrue(() => processes.sleepBlocked() === blocked),
    async dispose() {},
  };
});
