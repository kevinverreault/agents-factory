// The Agent SDK adapter behind the executor port (ADR 0001). The SDK version
// is pinned exactly and its bundled `claude.exe` runs every run. The daemon
// spawns that CLI itself, through `spawnClaudeCodeProcess`, so it knows its
// PID (ADR 0003). The SDK stream is normalised into factory run events here
// and nowhere else.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getSessionMessages,
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { Answers, Mode, Question, RunEvent } from '../lifecycle/lifecycle.ts';
import { processCreatedAt } from '../os/process-info.ts';
import type { ConversationEvent, CredentialProfile, Executor, RunSink, RunStart } from './executor.ts';
import { hitlFactoryTools, type FactoryTools } from './factory-tools.ts';
import { streamedInput, type StreamedInput } from './streamed-input.ts';

type LiveRun = {
  input: StreamedInput;
  query: Query;
  sink: RunSink;
  mode: Mode;
  maxTurns: number | null;
  // The CLI the run spawned, once known. Reported once: every turn starts with an init.
  cli: Promise<{ pid: number; createdAt: number }> | null;
  reportedStart: boolean;
  // The question card the turn waits on: resolved with the operator's answers,
  // or null once the turn or the run is cut.
  asking: { id: string; resolve(answers: Answers | null): void } | null;
  stopped: boolean;
};

const SUMMARY_LENGTH = 200;

// The `hook` CLI, which relays each PostToolUse hook event to the daemon for
// artifact capture. Spawned directly by Claude Code, with no shell between.
const RELAY_HOOK = { command: process.execPath, args: [fileURLToPath(new URL('../cli.ts', import.meta.url)), 'hook'] };

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
      const unstartable = whyUnstartable(start);
      if (unstartable) {
        queueMicrotask(() => sink.report({ type: 'runFailed', runId: start.runId, reason: unstartable }));
        return;
      }
      // Exists before the query does: the SDK may spawn the CLI at once.
      const spawning: Omit<LiveRun, 'query'> = {
        input: streamedInput(),
        sink,
        mode: start.mode,
        maxTurns: start.maxTurns,
        cli: null,
        reportedStart: false,
        asking: null,
        stopped: false,
      };
      const options: Options = {
        ...(start.mode === 'HITL'
          ? hitlOptions(start.credential, askTheOperator(start.runId, spawning, hitlRefusal), hitlFactoryTools(start.runId, sink))
          : l1Options(start.credential, start.maxTurns, askTheOperator(start.runId, spawning, l1Refusal))),
        cwd: start.cwd!,
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

    interrupt(runId) {
      const run = runs.get(runId);
      if (run && !run.stopped) void run.query.interrupt().catch(() => {});
    },

    answer(runId, questionId, answers) {
      const { asking } = runs.get(runId) ?? {};
      if (asking?.id === questionId) asking.resolve(answers);
    },

    stop(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.stopped = true;
      run.asking?.resolve(null);
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
    // Nothing is reported once the run has ended.
    let ended = false;
    const report = (event: RunEvent) => {
      if (run.stopped || ended) return;
      ended = event.type === 'runCompleted' || event.type === 'runFailed';
      run.sink.report(event);
    };
    try {
      for await (const message of run.query) {
        if (run.stopped) return;
        if (message.type === 'system' && message.subtype === 'init' && !run.reportedStart && run.cli) {
          run.reportedStart = true;
          report({ type: 'runStarted', runId, ...(await run.cli), model: message.model });
        } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
          for (const event of eventsOf('assistant', message.uuid, message.message)) run.sink.converse(event);
        } else if (message.type === 'result' && run.mode === 'HITL') {
          // Every turn ends with a result, an interrupted one included.
          report({ type: 'turnEnded', runId });
        } else if (message.type === 'result') {
          // An AFK run is one turn on its first message, and takes no chat:
          // its result ends it, completed once the CLI exits, or failed.
          const failure = afkFailure(message, run.maxTurns);
          if (!failure) {
            run.input.close();
            continue;
          }
          report({ type: 'runFailed', runId, reason: failure });
          run.input.close();
          run.query.close();
          return;
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
// plus the skill set plugin and the factory MCP server. Edits and the
// factory's tools are accepted, and `canUseTool` decides the rest. Every tool
// call's outcome goes to artifact capture, in the background so the run never
// waits on it.
function hitlOptions(credential: CredentialProfile, canUseTool: CanUseTool, factory: FactoryTools): Options {
  return {
    env: runEnv(credential),
    permissionMode: 'acceptEdits',
    mcpServers: { factory: factory.server },
    allowedTools: factory.allowed,
    settingSources: ['user', 'project', 'local'],
    settings: { hooks: { PostToolUse: [{ hooks: [{ type: 'command', ...RELAY_HOOK, async: true, timeout: 30 }] }] } },
    canUseTool,
  };
}

// L1 AFK runs (ADR 0007) execute in the host worktree with edits accepted.
// They load only project settings, with auto memory off, so they are the
// same from one run to the next (ADR 0005), and `maxTurns` is their runaway
// guard (ADR 0008). `canUseTool` turns their questions into attention
// requests; nothing else that would prompt gets through until the factory's
// allow list and permission requests arrive with their own slice.
function l1Options(credential: CredentialProfile, maxTurns: number | null, canUseTool: CanUseTool): Options {
  return {
    env: { ...runEnv(credential), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    permissionMode: 'acceptEdits',
    settingSources: ['project'],
    settings: { hooks: { PostToolUse: [{ hooks: [{ type: 'command', ...RELAY_HOOK, async: true, timeout: 30 }] }] } },
    ...(maxTurns !== null && { maxTurns }),
    canUseTool,
  };
}

// Why the executor can't start the run, or null.
function whyUnstartable({ mode, autonomy, cwd, firstMessage }: RunStart): string | null {
  if (cwd === null) return 'The task has no worktree to run in.';
  if (mode === 'HITL') return null;
  if (autonomy !== 'L1') return 'L2 runs arrive with the sandbox.';
  // An AFK run takes no chat, so with nothing to start on it would wait forever.
  return firstMessage === null ? 'The AFK run has no first message to work on.' : null;
}

// Why an AFK run's result fails it, or null when it completed.
function afkFailure(result: SDKResultMessage, maxTurns: number | null): string | null {
  if (result.subtype === 'error_max_turns') return `The run hit its max turns (${maxTurns ?? result.num_turns}) before it finished.`;
  if (result.subtype !== 'success') return result.errors.join(' ') || `The run ended on ${result.subtype}.`;
  return result.is_error ? result.result : null;
}

// Why a run may not use a tool that would prompt, by mode.
const hitlRefusal = (toolName: string) =>
  `The factory can't ask the operator for permission to use ${toolName} yet. Say what you wanted to do instead.`;
const l1Refusal = (toolName: string) => `This unattended run may not use ${toolName}. Do without it, and say what you would have done.`;

// `AskUserQuestion` holds the turn until the operator answers it: a question
// card in a HITL conversation, a question attention request that suspends an
// AFK run. Anything else that would prompt is refused with `refusal`.
function askTheOperator(runId: string, run: Omit<LiveRun, 'query'>, refusal: (toolName: string) => string): CanUseTool {
  return async (toolName, input, { signal, toolUseID }) => {
    if (toolName !== 'AskUserQuestion') return { behavior: 'deny', message: refusal(toolName) };
    // One question at a time.
    if (run.asking) return { behavior: 'deny', message: 'Another question is still open: ask one card at a time.' };
    const answers = await new Promise<Answers | null>((resolve) => {
      if (run.stopped || signal.aborted) return resolve(null);
      run.asking = { id: toolUseID, resolve };
      signal.addEventListener('abort', () => resolve(null), { once: true });
      const question = { id: toolUseID, questions: questionsIn(input) };
      run.sink.report(
        run.mode === 'HITL' ? { type: 'questionAsked', runId, question } : { type: 'attentionRaised', runId, kind: 'question', question },
      );
    });
    run.asking = null;
    return answers
      ? { behavior: 'allow', updatedInput: { ...input, answers } }
      : { behavior: 'deny', message: 'The operator dismissed the question.' };
  };
}

// The card's questions, without what the factory doesn't show (previews).
function questionsIn(input: Record<string, unknown>): Question['questions'] {
  return ((input.questions ?? []) as Question['questions']).map(({ question, header, options, multiSelect }) => ({
    question,
    header,
    options: options.map(({ label, description }) => ({ label, description })),
    multiSelect: Boolean(multiSelect),
  }));
}

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
  // `AskUserQuestion` is pointed at its first question.
  const asked = Array.isArray(fields.questions) ? (fields.questions[0] as { question?: unknown } | undefined)?.question : undefined;
  if (typeof asked === 'string') return oneLine(asked);
  const pick = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'description', 'path']
    .map((name) => fields[name])
    .find((value): value is string => typeof value === 'string');
  return oneLine((pick ?? Object.values(fields).find((value) => typeof value === 'string') ?? '') as string);
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
}
