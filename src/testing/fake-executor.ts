import { ArchiveError, type ConversationEvent, type Executor, type RunSink, type RunStart, type Session, type Verdict } from '../executor/executor.ts';
import type { Answers, RunEvent } from '../lifecycle/lifecycle.ts';
import type { ToolCall } from '../permissions/permissions.ts';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

// A scripted executor: records the runs it was asked to start and stop and
// the messages sent to them, and lets a test report run events and converse
// for them as the agent would. Each session's events also go to its
// transcript, which stands in for the Claude session file.
export class FakeExecutor implements Executor {
  readonly started: RunStart[] = [];
  readonly stopped: string[] = [];
  readonly sent: { runId: string; text: string }[] = [];
  readonly interrupted: string[] = [];
  readonly answered: { runId: string; questionId: string; answers: Answers }[] = [];
  readonly permitted: { runId: string; callId: string; verdict: Verdict }[] = [];
  readonly historyReads: Session[] = [];
  // Each session archived, where, and how many events it held then.
  readonly archived: { sessionId: string; dir: string; events: number }[] = [];
  // Each archive directory's copies, by session id.
  private readonly archives = new Map<string, Map<string, ConversationEvent[]>>();
  private archiveFailure: string | null = null;
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

  interrupt(runId: string): void {
    this.interrupted.push(runId);
  }

  answer(runId: string, questionId: string, answers: Answers): void {
    this.answered.push({ runId, questionId, answers });
  }

  permit(runId: string, callId: string, verdict: Verdict): void {
    this.permitted.push({ runId, callId, verdict });
  }

  stop(runId: string): void {
    this.stopped.push(runId);
  }

  async history(session: Session): Promise<ConversationEvent[]> {
    this.historyReads.push(session);
    await this.held;
    const from = session.archive ? this.archives.get(session.archive) : this.transcripts;
    return [...(from?.get(session.sessionId) ?? [])];
  }

  async archive({ sessionId }: Session, dir: string): Promise<void> {
    if (this.archiveFailure) throw new ArchiveError(this.archiveFailure);
    const transcript = this.transcripts.get(sessionId);
    if (!transcript) return;
    const copies = this.archives.get(dir) ?? new Map<string, ConversationEvent[]>();
    this.archives.set(dir, copies.set(sessionId, [...transcript]));
    this.archived.push({ sessionId, dir, events: transcript.length });
  }

  // Archiving fails with `reason` from now on, or works again (null).
  failArchive(reason: string | null): void {
    this.archiveFailure = reason;
  }

  report(runId: string, event: DistributiveOmit<RunEvent, 'runId'>): void {
    this.run(runId).sink.report({ ...event, runId } as RunEvent);
  }

  // Claude Code asks whether the run's agent may make a tool call. Its
  // summary is its command, or else its file path or URL.
  askPermission(runId: string, call: Omit<ToolCall, 'summary'> & { summary?: string }): void {
    const { command, file_path, url } = call.input;
    const summary = call.summary ?? String(command ?? file_path ?? url ?? '');
    this.run(runId).sink.askPermission({ ...call, summary });
  }

  // The verdicts the run's tool calls got, by call id.
  verdicts(runId: string): Record<string, Verdict> {
    return Object.fromEntries(this.permitted.filter((p) => p.runId === runId).map((p) => [p.callId, p.verdict]));
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
