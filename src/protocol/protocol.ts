// The daemon ↔ client protocol (ADR 0002): newline-delimited JSON over a named
// pipe (Windows) or a Unix socket. The daemon speaks first with its protocol
// version; the client answers with the token from the operator's app-data
// directory, and only then may it subscribe or send commands.
import type { Socket } from 'node:net';
import type { ConversationEvent } from '../executor/executor.ts';
import type { AutonomyLevel, HandoffChoices, OperatorCommand, Priority } from '../lifecycle/lifecycle.ts';
import type { Tier } from '../models/routing.ts';
import type { PresetChoice } from '../presets/presets.ts';
import type { FactoryState, PatchOp } from './factory-state.ts';

export const PROTOCOL_VERSION = 15;

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
// The factory identity (ADR 0004). `setupGitHub` creates the App from the
// code GitHub's manifest flow redirected back with, and keeps its key in the
// credential store; it replies with a `SetupView`. `checkApp` asks GitHub
// again whether the App is installed on the repository, and replies with the
// repository's `AppCheck`.
export type GitHubCommand = { type: 'setupGitHub'; code: string } | { type: 'checkApp'; repo: string };
export type SetupView = { slug: string; installationSettings: string };
// Launches a task from the launch card: the preset (by default the
// repository's) is resolved and frozen, and the task starts at `stage` (by
// default the first) in a new worktree. Replies with `{ taskId }`.
export type LaunchCommand = {
  type: 'launchTask';
  repo: string;
  preset?: string;
  stage?: string;
  prompt?: string;
  // `#12`, `owner/name#12` or issue URLs.
  issues?: string[];
  groups?: string[];
  // The operator's tier, over the start stage's.
  tier?: Tier;
  // The handoff fields an AFK start stage takes: its autonomy level (L1 by
  // default), max turns (over the stage's `max_turns`) and priority.
  autonomy?: AutonomyLevel;
  maxTurns?: number;
  priority?: Priority;
};
// The advance sheet's confirm: the HITL task leaves its stage for the next
// one, skipping the optional stages named in `skip`.
export type AdvanceCommand = { type: 'advanceStage'; taskId: string; skip?: string[] };
// The handoff sheet (`ctrl+h` or `/handoff`): opening it has the HITL run
// write the brief, interrupting the agent mid-turn or resuming a parked
// conversation, and `closeHandoff` backs out. `handoff` confirms it with the
// brief and fields as the operator left them.
export type HandoffCommand = { type: 'openHandoff'; taskId: string } | ({ type: 'handoff'; taskId: string } & HandoffChoices);
// What a launch card offers in a repository. Replies with a `PresetsView`.
export type PresetCommand = { type: 'listPresets'; repo: string };
export type PresetsView = {
  presets: PresetChoice[];
  // The preset the card starts on, and why it isn't the repository's own default.
  defaultPreset: string;
  warning: string | null;
};
// A Claude Code hook event, as the hook gets it on stdin, relayed by the
// `hook` CLI. Only the fields artifact capture reads are typed.
export type HookEvent = {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
};
export type HookCommand = { type: 'hookEvent'; event: HookEvent };
export type Command =
  | OperatorCommand
  | DaemonCommand
  | RepoCommand
  | GitHubCommand
  | LaunchCommand
  | AdvanceCommand
  | HandoffCommand
  | PresetCommand
  | HookCommand;

export type DaemonStatus = {
  pid: number;
  protocolVersion: number;
  startedAt: number;
  attachedTuis: number;
  activeRuns: number;
  suspendedRuns: number;
  queuedTasks: number;
};

// A refusal with `confirm` asks the operator whether to go ahead anyway, as
// Mark done on an unmerged branch does: `confirm` is the command that does.
export type Reply = { ok: true; value?: unknown } | { ok: false; reason: string; confirm?: Command };

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
