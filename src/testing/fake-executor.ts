import type { ConversationEvent, Executor, RunSink, RunStart, Session } from '../executor/executor.ts';
import type { RunEvent } from '../lifecycle/lifecycle.ts';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

// A scripted executor: records the runs it was asked to start and stop and
// the messages sent to them, and lets a test report run events and converse
// for them as the agent would. Each session's events also go to its
// transcript, which stands in for the Claude session file.
export class FakeExecutor implements Executor {
  readonly started: RunStart[] = [];
  readonly stopped: string[] = [];
  readonly sent: { runId: string; text: string }[] = [];
  readonly historyReads: Session[] = [];
  private readonly runs = new Map<string, { sink: RunSink; sessionId: string }>();
  private readonly transcripts = new Map<string, ConversationEvent[]>();
  private events = 0;
  private held: Promise<void> = Promise.resolve();

  start(run: RunStart, sink: RunSink): void {
    this.started.push(run);
    this.runs.set(run.runId, { sink, sessionId: run.sessionId });
    if (run.firstMessage !== null) this.converse(run.runId, { type: 'message', from: 'operator', text: run.firstMessage });
  }

  send(runId: string, text: string): void {
    this.sent.push({ runId, text });
    this.converse(runId, { type: 'message', from: 'operator', text });
  }

  stop(runId: string): void {
    this.stopped.push(runId);
  }

  async history(session: Session): Promise<ConversationEvent[]> {
    this.historyReads.push(session);
    await this.held;
    return [...(this.transcripts.get(session.sessionId) ?? [])];
  }

  report(runId: string, event: DistributiveOmit<RunEvent, 'runId'>): void {
    this.run(runId).sink.report({ ...event, runId } as RunEvent);
  }

  // The agent says or does something in the run. With `inHistory: false` it
  // isn't in the session file yet when the history is next read.
  converse(runId: string, event: DistributiveOmit<ConversationEvent, 'id'>, { inHistory = true } = {}): void {
    const { sink, sessionId } = this.run(runId);
    const full = { ...event, id: `E${++this.events}` } as ConversationEvent;
    if (inHistory) this.transcripts.set(sessionId, [...(this.transcripts.get(sessionId) ?? []), full]);
    sink.converse(full);
  }

  // History reads wait until the returned function is called.
  holdHistory(): () => void {
    let release!: () => void;
    this.held = new Promise((resolve) => (release = resolve));
    return release;
  }

  private run(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`The executor never started run ${runId}.`);
    return run;
  }
}
