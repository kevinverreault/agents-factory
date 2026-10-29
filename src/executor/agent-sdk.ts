// The Agent SDK adapter behind the executor port (ADR 0001). The SDK version
// is pinned exactly and its bundled `claude.exe` runs every run. The daemon
// spawns that CLI itself, through `spawnClaudeCodeProcess`, so it knows its
// PID (ADR 0003). The SDK stream is normalised into factory run events here
// and nowhere else.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  getSessionMessages,
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { processCreatedAt } from '../os/process-info.ts';
import type { ConversationEvent, CredentialProfile, Executor, RunSink } from './executor.ts';
import { streamedInput, type StreamedInput } from './streamed-input.ts';

type LiveRun = {
  input: StreamedInput;
  query: Query;
  sink: RunSink;
  // The CLI the run spawned, once known. Reported once: every turn starts with an init.
  cli: Promise<{ pid: number; createdAt: number }> | null;
  reportedStart: boolean;
  stopped: boolean;
};

const SUMMARY_LENGTH = 200;

export function agentSdkExecutor(): Executor {
  const runs = new Map<string, LiveRun>();

  function say(runId: string, text: string): void {
    const run = runs.get(runId);
    if (!run || run.stopped) return;
    const uuid = randomUUID();
    run.input.send(text, uuid);
    run.sink.converse({ type: 'message', id: `${uuid}:0`, from: 'operator', text });
  }

  return {
    start(start, sink) {
      if (start.mode !== 'HITL' || start.cwd === null) {
        queueMicrotask(() =>
          sink.report({
            type: 'runFailed',
            runId: start.runId,
            reason: start.cwd === null ? 'The task has no worktree to run in.' : 'AFK runs arrive with the autonomy gate.',
          }),
        );
        return;
      }
      // Exists before the query does: the SDK may spawn the CLI at once.
      const spawning: Omit<LiveRun, 'query'> = { input: streamedInput(), sink, cli: null, reportedStart: false, stopped: false };
      const options: Options = {
        ...hitlOptions(start.credential),
        cwd: start.cwd,
        model: start.model,
        // Skills dispatch as `/factory:<skill>`, so no other copy can shadow them.
        ...(start.plugin !== null && { plugins: [{ type: 'local', path: start.plugin }] }),
        ...(start.resumesSession ? { resume: start.sessionId } : { sessionId: start.sessionId }),
        spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
          const child = spawnCli(spawnOptions);
          const spawnedAt = Date.now();
          const pid = child.pid!;
          spawning.cli = processCreatedAt(pid).then(
            (createdAt) => ({ pid, createdAt }),
            () => ({ pid, createdAt: spawnedAt }),
          );
          return child;
        },
      };
      const run: LiveRun = Object.assign(spawning, { query: query({ prompt: spawning.input.messages, options }) });
      runs.set(start.runId, run);
      if (start.firstMessage !== null) say(start.runId, start.firstMessage);
      void consume(start.runId, run);
    },

    send: say,

    stop(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.stopped = true;
      runs.delete(runId);
      run.input.close();
      run.query.close();
    },

    async history({ sessionId, cwd }) {
      const messages = await getSessionMessages(sessionId, { dir: cwd });
      return messages.flatMap((message) =>
        message.type === 'system' || message.parent_tool_use_id ? [] : eventsOf(message.type, message.uuid, message.message),
      );
    },
  };

  // Turns the run's SDK messages into run events and conversation events,
  // until the run ends or the daemon stops it.
  async function consume(runId: string, run: LiveRun): Promise<void> {
    const report = (event: RunEvent) => {
      if (!run.stopped) run.sink.report(event);
    };
    try {
      for await (const message of run.query) {
        if (run.stopped) return;
        if (message.type === 'system' && message.subtype === 'init' && !run.reportedStart && run.cli) {
          run.reportedStart = true;
          report({ type: 'runStarted', runId, ...(await run.cli), model: message.model });
        } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
          for (const event of eventsOf('assistant', message.uuid, message.message)) run.sink.converse(event);
        }
      }
      report({ type: 'runCompleted', runId });
    } catch (error) {
      // The SDK throws once the CLI returns an error result.
      report({ type: 'runFailed', runId, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      runs.delete(runId);
    }
  }
}

// HITL runs act as the operator (ADR 0005): every settings source loads,
// plus the skill set plugin. Edits are accepted; anything
// that would prompt is refused until the conversation view can ask, and so
// are questions, which it can't show yet.
function hitlOptions(credential: CredentialProfile): Options {
  return {
    env: runEnv(credential),
    permissionMode: 'acceptEdits',
    settingSources: ['user', 'project', 'local'],
    canUseTool: refuseInConversation,
  };
}

const refuseInConversation: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message:
    toolName === 'AskUserQuestion'
      ? 'Ask the operator in plain text instead: the factory shows no question cards yet.'
      : `The factory can't ask the operator for permission to use ${toolName} yet. Say what you wanted to do instead.`,
});

// The daemon's environment (keeping PATH, USERPROFILE, APPDATA), with the
// credential profile applied: on `subscription-host` the CLI uses the
// operator's login, so an API key in the daemon's environment must not win.
function runEnv(credential: CredentialProfile): Record<string, string | undefined> {
  switch (credential) {
    case 'subscription-host': {
      const { ANTHROPIC_API_KEY, ...env } = process.env;
      return env;
    }
  }
}

function spawnCli({ command, args, cwd, env, signal }: SpawnOptions) {
  return spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
}

type Block = { type: string; text?: string; name?: string; input?: unknown };

// The conversation events in one message, live or from the session file.
// Each content block is one event, named by the message's uuid and its index.
export function eventsOf(type: 'user' | 'assistant', uuid: string, message: unknown): ConversationEvent[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (type === 'user') {
    // Tool results come back as user messages too; only typed text is the operator's.
    return typeof content === 'string' ? [{ type: 'message', id: `${uuid}:0`, from: 'operator', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return (content as Block[]).flatMap((block, index): ConversationEvent[] => {
    const id = `${uuid}:${index}`;
    if (block.type === 'text' && block.text?.trim()) return [{ type: 'message', id, from: 'agent', text: block.text }];
    if (block.type === 'tool_use' && block.name) return [{ type: 'toolUse', id, tool: block.name, summary: summarise(block.input) }];
    return [];
  });
}

// What a tool call was pointed at, on one line.
function summarise(input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>;
  const pick = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'description', 'path']
    .map((name) => fields[name])
    .find((value): value is string => typeof value === 'string');
  const summary = (pick ?? Object.values(fields).find((value) => typeof value === 'string') ?? '') as string;
  const line = summary.replace(/\s+/g, ' ').trim();
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
}
