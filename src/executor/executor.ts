// The executor port: starts and stops runs, and reports their run events.
// The Agent SDK adapter arrives with the first conversation slice; until then
// the daemon runs with `noExecutor`.
import type { AutonomyLevel, Mode, RunEvent } from '../lifecycle/lifecycle.ts';

export type RunStart = {
  runId: string;
  taskId: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  sessionId: string;
  resumesSession: boolean;
};

export interface Executor {
  start(run: RunStart, report: (event: RunEvent) => void): void;
  stop(runId: string): void;
}

// Fails every run it is given, saying why.
export const noExecutor: Executor = {
  start(run, report) {
    queueMicrotask(() => report({ type: 'runFailed', runId: run.runId, reason: 'This factory has no executor yet.' }));
  },
  stop() {},
};
