// The daemon ↔ client protocol (ADR 0002): newline-delimited JSON over a named
// pipe (Windows) or a Unix socket. The daemon speaks first with its protocol
// version; the client answers with the token from the operator's app-data
// directory, and only then may it subscribe or send commands.
import type { Socket } from 'node:net';
import type { ConversationEvent } from '../executor/executor.ts';
import type { OperatorCommand } from '../lifecycle/lifecycle.ts';
import type { FactoryState, PatchOp } from './factory-state.ts';

export const PROTOCOL_VERSION = 4;

export type DaemonCommand = { type: 'daemon.status' } | { type: 'daemon.stop' };
// Repository verbs the daemon answers by reading the clone first. `path` is
// absolute: the daemon's working directory is not the client's.
export type RepoCommand =
  | { type: 'registerRepo'; path: string; baseBranch?: string; defaultPreset?: string }
  // Re-points the repository whose clone now holds `path` (ADR 0010).
  // Replies with its `RepositoryView`, like `registerRepo`.
  | { type: 'moveRepo'; path: string }
  // Replies with the `CloneView` of the clone holding `path`.
  | { type: 'inspectClone'; path: string };

export type CloneView = { repo: string; path: string };
// Launches a HITL task from the launch card: one stage, a conversation in a
// new worktree. Replies with `{ taskId }`.
export type LaunchCommand = { type: 'launchTask'; repo: string; prompt: string };
export type Command = OperatorCommand | DaemonCommand | RepoCommand | LaunchCommand;

export type DaemonStatus = {
  pid: number;
  protocolVersion: number;
  startedAt: number;
  attachedTuis: number;
  activeRuns: number;
  suspendedRuns: number;
  queuedTasks: number;
};

export type Reply = { ok: true; value?: unknown } | { ok: false; reason: string };

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe' }
  // The per-run conversation subscription: the history replayed from the
  // Claude session file, then live events, until the client leaves.
  | { type: 'converse'; runId: string }
  | { type: 'leaveConversation'; runId: string }
  | { type: 'command'; id: number; command: Command };

export type DaemonMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'welcome' }
  | { type: 'refused'; reason: string }
  | { type: 'snapshot'; state: FactoryState }
  | { type: 'patch'; ops: PatchOp[] }
  | { type: 'conversation'; runId: string; event: ConversationEvent }
  | ({ type: 'reply'; id: number } & Reply);

export function send(socket: Socket, message: ClientMessage | DaemonMessage): void {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
}

// Calls `onMessage` with each complete line received, parsed. A line that
// isn't JSON ends the connection.
export function readMessages<T>(socket: Socket, onMessage: (message: T) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let message: T;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      onMessage(message);
    }
  });
}
