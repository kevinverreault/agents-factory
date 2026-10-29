import type { Executor, RunStart } from '../executor/executor.ts';
import type { RunEvent } from '../lifecycle/lifecycle.ts';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

// A scripted executor: records the runs it was asked to start and stop, and
// lets a test report run events for them as the agent would.
export class FakeExecutor implements Executor {
  readonly started: RunStart[] = [];
  readonly stopped: string[] = [];
  private readonly reporters = new Map<string, (event: RunEvent) => void>();

  start(run: RunStart, report: (event: RunEvent) => void): void {
    this.started.push(run);
    this.reporters.set(run.runId, report);
  }

  stop(runId: string): void {
    this.stopped.push(runId);
  }

  report(runId: string, event: DistributiveOmit<RunEvent, 'runId'>): void {
    const reporter = this.reporters.get(runId);
    if (!reporter) throw new Error(`The executor never started run ${runId}.`);
    reporter({ ...event, runId } as RunEvent);
  }
}
