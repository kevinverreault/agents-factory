// The executor port: starts and stops runs, takes the operator's messages,
// and reports run events and the conversation. The Agent SDK adapter
// (`agent-sdk.ts`) is the real one.
import type { Answers, AutonomyLevel, Mode, RunEvent } from '../lifecycle/lifecycle.ts';
import type { ToolCall } from '../permissions/permissions.ts';

export type RunStart = {
  runId: string;
  taskId: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  sessionId: string;
  resumesSession: boolean;
  // The task's worktree, or null for a task launched without one.
  cwd: string | null;
  // The task's goal, sent as the run's first message: for a launched task,
  // its start stage's skill invoked on the launch inputs.
  firstMessage: string | null;
  model: string;
  // An AFK run's runaway guard: hitting it fails the run. Null for HITL.
  maxTurns: number | null;
  credential: CredentialProfile;
  // The directory of the skill set plugin the run loads (ADR 0005), or null
  // for a task that froze none.
  plugin: string | null;
  // What keeps an AFK run from publishing around the factory (ADR 0007), or
  // null for a HITL run, which acts as the operator.
  guards: RunGuards | null;
};

export type RunGuards = {
  // The commit the run starts from: history from before it stays as it is.
  start: string;
  // The cleaned git environment, over the run's own.
  env: Record<string, string>;
};

// How a run authenticates: chosen per run, and only applied by the executor
// (ADR 0001). For now the operator's own subscription login on the host; the
// container and API-key profiles arrive with L2 and the fallback.
export type CredentialProfile = 'subscription-host';

// What a conversation shows: factory run events, never SDK message types. An
// event's `id` is the same live and replayed from the session file.
export type ConversationEvent =
  | { type: 'message'; id: string; from: 'operator' | 'agent'; text: string }
  // `summary` is what the tool was pointed at: a command, a path, a pattern.
  | { type: 'toolUse'; id: string; tool: string; summary: string };

// Where a run sends what happens in it.
export type RunSink = {
  // Run events change the Lifecycle.
  report(event: RunEvent): void;
  converse(event: ConversationEvent): void;
  // An AFK run's tool call that Claude Code asked about: the factory's gate
  // decides it (ADR 0007), and the call waits for `permit`.
  askPermission(call: ToolCall): void;
};

// What a tool call is allowed to do: run, or be refused with a message the
// agent reads.
export type Verdict = { allow: true } | { allow: false; message: string };

export type Session = { sessionId: string; cwd: string };

export interface Executor {
  start(run: RunStart, sink: RunSink): void;
  // Sends the operator's message to a live run.
  send(runId: string, text: string): void;
  // Cuts the run's current turn short. The turn's end is reported as usual.
  interrupt(runId: string): void;
  // Answers the question card the run's turn waits on.
  answer(runId: string, questionId: string, answers: Answers): void;
  // Decides the tool call the run asked permission for.
  permit(runId: string, callId: string, verdict: Verdict): void;
  stop(runId: string): void;
  // The conversation so far, read from the Claude session file.
  history(session: Session): Promise<ConversationEvent[]>;
}
