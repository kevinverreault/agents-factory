// The Agent SDK adapter behind the executor port (ADR 0001). The SDK version
// is pinned exactly and its bundled `claude.exe` runs every run. The daemon
// spawns that CLI itself, through `spawnClaudeCodeProcess`, so it knows its
// PID (ADR 0003). The SDK stream is normalised into factory run events here
// and nowhere else.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSessionInfo,
  getSessionMessages,
  importSessionToStore,
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type Query,
  type SDKResultMessage,
  type SessionKey,
  type SessionStore,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { HARD_DENY_RULES, refusal, runHistoryIn } from '../guards/hard-denies.ts';
import { AFK_UNSET } from '../guards/run-git.ts';
import type { Answers, Mode, Question, RunEvent } from '../lifecycle/lifecycle.ts';
import type { ModelUsage, Usage } from '../usage/usage.ts';
import { processCreatedAt } from '../os/process-info.ts';
import { ArchiveError, type ConversationEvent, type CredentialProfile, type Executor, type RunSink, type RunStart, type Verdict } from './executor.ts';
import { afkFactoryTools, hitlFactoryTools, type FactoryTools } from './factory-tools.ts';
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
  // The tool calls waiting on the factory's gate, by tool use id: resolved
  // with its verdict, or null once the run is cut.
  permitting: Map<string, (verdict: Verdict | null) => void>;
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
        permitting: new Map(),
        stopped: false,
      };
      // HITL and L1 runs hand what would prompt to the factory's gate: a HITL
      // run's asks with a card in its conversation, an L1 run's with a
      // request. An L2 run's container prompts for nothing but questions.
      const canUseTool = askTheOperator(start.runId, spawning, gateCall(spawning));
      const options: Options = {
        ...(start.mode === 'HITL'
          ? hitlOptions(start.credential, canUseTool, hitlFactoryTools(start.runId, sink, start))
          : start.container
            ? l2Options(start, askTheOperator(start.runId, spawning, allowInContainer), afkFactoryTools(start.runId, sink, start.reports, start))
            : l1Options(start, canUseTool, afkFactoryTools(start.runId, sink, start.reports, start))),
        cwd: start.cwd!,
        model: start.model,
        // Skills dispatch as `/factory:<skill>`, so no other copy can shadow
        // them. An L2 run loads the container's copy.
        ...(start.plugin !== null && { plugins: [{ type: 'local', path: start.container?.plugin ?? start.plugin }] }),
        ...(start.resumesSession ? { resume: start.sessionId } : { sessionId: start.sessionId }),
        spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
          // In a container, its own Linux CLI takes the same arguments; the
          // PID recorded is `docker exec`'s, which the descendant sweep reaches.
          const child = start.container
            ? start.container.spawn('claude', spawnOptions.args, { env: spawnOptions.env, signal: spawnOptions.signal })
            : spawnCli(spawnOptions);
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

    permit(runId, callId, verdict) {
      runs.get(runId)?.permitting.get(callId)?.(verdict);
    },

    stop(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.stopped = true;
      run.asking?.resolve(null);
      for (const resolve of run.permitting.values()) resolve(null);
      runs.delete(runId);
      run.input.close();
      run.query.close();
    },

    async history({ sessionId, cwd, archive }) {
      const messages = await getSessionMessages(sessionId, { dir: cwd, ...(archive ? { sessionStore: archiveStore(archive) } : {}) });
      return messages.flatMap((message) =>
        message.type === 'system' || message.parent_tool_use_id ? [] : eventsOf(message.type, message.uuid, message.message),
      );
    },

    sessionsDir(cwd) {
      return claudeProjectDir(cwd);
    },

    async archive({ sessionId, cwd }, dir) {
      try {
        if (!(await getSessionInfo(sessionId, { dir: cwd }))) return;
        // A copy from an earlier try goes first: the import appends.
        rmSync(join(dir, `${sessionId}.jsonl`), { force: true });
        rmSync(join(dir, sessionId), { recursive: true, force: true });
        await importSessionToStore(sessionId, archiveStore(dir), { dir: cwd });
      } catch (error) {
        throw new ArchiveError((error as Error).message);
      }
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
    // How full the session is, as the main agent's latest API call left it.
    let latest: { used: number; model: string } | null = null;
    // An AFK run's final result text: a child's report summary if it reported none.
    let result: string | undefined;
    try {
      for await (const message of run.query) {
        if (run.stopped) return;
        if (message.type === 'system' && message.subtype === 'init' && !run.reportedStart && run.cli) {
          run.reportedStart = true;
          report({ type: 'runStarted', runId, ...(await run.cli), model: message.model });
        } else if (message.type === 'assistant') {
          // In-run subagents' messages count in the run's usage, never in its conversation.
          const sampled = sampleOf(message.message);
          if (sampled) report({ type: 'usageSampled', runId, ...sampled });
          if (message.parent_tool_use_id) continue;
          latest = contextOf(message.message) ?? latest;
          for (const event of eventsOf('assistant', message.uuid, message.message)) run.sink.converse(event);
        } else if (message.type === 'result' && run.mode === 'HITL') {
          // Every turn ends with a result, an interrupted one included.
          report(totalOf(runId, message));
          const window = latest && message.modelUsage[latest.model]?.contextWindow;
          report({ type: 'turnEnded', runId, ...(latest && window && { context: { used: latest.used, window } }) });
        } else if (message.type === 'result') {
          // An AFK run is one turn on its first message, and takes no chat:
          // its result ends it, completed once the CLI exits, or failed.
          report(totalOf(runId, message));
          const failure = afkFailure(message, run.maxTurns);
          if (!failure) {
            if (message.subtype === 'success') result = message.result;
            run.input.close();
            continue;
          }
          report({ type: 'runFailed', runId, reason: failure });
          run.input.close();
          run.query.close();
          return;
        }
      }
      report({ type: 'runCompleted', runId, ...(result !== undefined && { result }) });
    } catch (error) {
      // The SDK throws once the CLI returns an error result.
      report({ type: 'runFailed', runId, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      runs.delete(runId);
    }
  }
}

// The directory Claude Code keeps the sessions of runs in `cwd` in: under
// its config directory's `projects`, named for `cwd` with every character
// but letters and digits turned into `-` (as `claude.exe` 2.1.312 names it).
// A name it would shorten with a hash, past 200 characters, isn't matched.
export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length > 200) throw new Error(`The worktree path ${cwd} is too long for an L2 container to share its sessions.`);
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', name);
}

// The session transcripts archived in `dir` (ADR 0011), one JSONL file per
// session as the CLI writes it, and its in-run subagents' under the
// session's id. The directory is the task's alone, so the project key plays
// no part.
function archiveStore(dir: string): SessionStore {
  const file = ({ sessionId, subpath }: SessionKey) => join(dir, subpath ? join(sessionId, `${subpath}.jsonl`) : `${sessionId}.jsonl`);
  return {
    async append(key, entries) {
      mkdirSync(dirname(file(key)), { recursive: true });
      appendFileSync(file(key), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    },
    async load(key) {
      let text: string;
      try {
        text = readFileSync(file(key), 'utf8');
      } catch (error) {
        // A transcript never archived; any other failure is the read's.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

// HITL runs act as the operator (ADR 0005): every settings source loads,
// plus the skill set plugin and the factory MCP server. Edits and the
// factory's tools are accepted, and `canUseTool` hands the rest to the
// factory's gate, which asks the operator with a card when no rule covers a call. Every tool
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
// guard (ADR 0008). Only policy-tier permission rules apply, so the target
// repo's own rules grant nothing. The run's allow rules are that tier's, so
// Claude Code's own engine matches them: it splits chained commands, reads
// heredocs and redirects, and lets read-only commands and file commands in
// the worktree through itself. Whatever would still prompt reaches
// `canUseTool`, which turns questions into attention requests and hands
// every other call to the factory's gate. The factory's MCP server, with
// the tools of what the run reports, is the only one it has, so the allow
// list's `mcp__factory` is its own.
//
// Every AFK run is guarded (ADR 0007): the hard-deny rules and a PreToolUse
// hook refuse what would publish or rewrite around the factory, before the
// gate is asked and whatever an allow rule says, and git runs in the cleaned
// environment, without the operator's credentials. Commits carry the
// factory's trailers, not Claude Code's attribution (ADR 0004).
function l1Options({ credential, maxTurns, guards, cwd, allowRules }: RunStart, canUseTool: CanUseTool, factory: FactoryTools): Options {
  // Python reads and writes files as UTF-8, not Windows' code page, so the
  // run needn't ask to set it for each script (T11).
  const env: Record<string, string | undefined> = { ...runEnv(credential), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', PYTHONUTF8: '1', ...guards!.env };
  for (const name of AFK_UNSET) delete env[name];
  return {
    env,
    permissionMode: 'acceptEdits',
    settingSources: ['project'],
    mcpServers: { factory: factory.server },
    strictMcpConfig: true,
    // Claude Code keeps the allow rules of the policy tier a parent process
    // hands it only while the machine has no managed settings of its own.
    // With them, it drops this tier unless their admin opts in, and even then
    // keeps no allow rules, so every call that would prompt reaches the gate.
    managedSettings: { allowManagedPermissionRulesOnly: true, permissions: { allow: [...allowRules], deny: [...HARD_DENY_RULES] } },
    settings: {
      hooks: { PostToolUse: [{ hooks: [{ type: 'command', ...RELAY_HOOK, async: true, timeout: 30 }] }] },
      attribution: { commit: '', pr: '' },
    },
    hooks: { PreToolUse: [{ hooks: [hardDenies(cwd!, guards!.start)] }] },
    ...(maxTurns !== null && { maxTurns }),
    canUseTool,
  };
}

// L2 AFK runs (ADR 0007) execute in their task's container, where nothing
// they do reaches the operator's machine or GitHub, so they ask no
// permissions: `bypassPermissions` lets every call run but what the hard
// denies refuse, which hold here as at L1, and questions still reach the
// operator through `canUseTool`. The environment is the container's alone:
// the run's subscription token, and its git and gh config, at their paths
// in the container. Nothing of the daemon's environment goes in. Artifact
// capture's relay hook runs on the host, so an L2 run has none. The SDK
// warns that `canUseTool` is never invoked under `bypassPermissions`, but
// AskUserQuestion still reaches it, as the L2 run contract test shows. The
// CLI sends no telemetry or error reports: the container's egress proxy
// would deny them, and they would crowd the hosts a failed run lists.
function l2Options({ maxTurns, guards, token, container }: RunStart, canUseTool: CanUseTool, factory: FactoryTools): Options {
  return {
    env: { CLAUDE_CODE_OAUTH_TOKEN: token!, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...guards!.env },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    mcpServers: { factory: factory.server },
    strictMcpConfig: true,
    managedSettings: { allowManagedPermissionRulesOnly: true, permissions: { deny: [...HARD_DENY_RULES] } },
    settings: { attribution: { commit: '', pr: '' } },
    hooks: { PreToolUse: [{ hooks: [hardDenies(container!.workdir, guards!.start, (args) => container!.git(args).then(({ code }) => code))] }] },
    ...(maxTurns !== null && { maxTurns }),
    canUseTool,
  };
}

// In a container, `bypassPermissions` asks about nothing but questions; any
// other call that reaches the gate anyway runs.
const allowInContainer: CanUseTool = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input });

// The PreToolUse hook that refuses the hard denies, whatever the gate would
// say, reading the run's history with `git`: on the host, or in the container.
function hardDenies(cwd: string, start: string, git?: (args: string[]) => Promise<number>): HookCallback {
  const history = runHistoryIn(cwd, start, git);
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const refused = await refusal({ tool: input.tool_name, input: (input.tool_input ?? {}) as Record<string, unknown> }, history);
    return refused ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refused } } : {};
  };
}

// Why the executor can't start the run, or null.
function whyUnstartable({ mode, autonomy, cwd, firstMessage, guards, container, credential, token }: RunStart): string | null {
  if (cwd === null) return 'The task has no worktree to run in.';
  if (mode === 'HITL') return null;
  if (guards === null) return 'An AFK run never starts without its git guards.';
  if (autonomy === 'L2' && (container === null || credential !== 'subscription-token' || !token)) {
    return 'An L2 run starts only in its task’s container, with its subscription token.';
  }
  if (autonomy !== 'L2' && container !== null) return 'Only an L2 run starts in a container.';
  // An AFK run takes no chat, so with nothing to start on it would wait forever.
  return firstMessage === null ? 'The AFK run has no first message to work on.' : null;
}

// Why an AFK run's result fails it, or null when it completed.
function afkFailure(result: SDKResultMessage, maxTurns: number | null): string | null {
  if (result.subtype === 'error_max_turns') return `The run hit its max turns (${maxTurns ?? result.num_turns}) before it finished.`;
  if (result.subtype !== 'success') return result.errors.join(' ') || `The run ended on ${result.subtype}.`;
  return result.is_error ? result.result : null;
}

// Hands a run's tool call to the factory's gate, and holds it until the
// gate's verdict: at once, or once the operator answers its permission
// request (an L1 run's) or card (a HITL run's).
function gateCall(run: Omit<LiveRun, 'query'>): CanUseTool {
  return async (toolName, input, { signal, toolUseID }) => {
    const verdict = await new Promise<Verdict | null>((resolve) => {
      if (run.stopped || signal.aborted) return resolve(null);
      run.permitting.set(toolUseID, resolve);
      signal.addEventListener('abort', () => resolve(null), { once: true });
      run.sink.askPermission({ id: toolUseID, tool: toolName, input, summary: summarise(input) });
    });
    run.permitting.delete(toolUseID);
    if (!verdict) return { behavior: 'deny', message: 'The run was stopped before the factory decided this call.' };
    return verdict.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict.message };
  };
}

// `AskUserQuestion` holds the turn until the operator answers it: a question
// card in a HITL conversation, a question attention request that suspends an
// AFK run. Anything else that would prompt goes to `otherwise`.
function askTheOperator(runId: string, run: Omit<LiveRun, 'query'>, otherwise: CanUseTool): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName !== 'AskUserQuestion') return otherwise(toolName, input, options);
    const { signal, toolUseID } = options;
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
    case 'subscription-token':
      // Only an L2 run, in its container, has this profile: `l2Options` builds its environment.
      throw new Error('A run on the host never uses the subscription-token profile.');
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

// The context an API call's message leaves the session with: every token it
// sent, cached or not, and every token it got back.
function contextOf(message: unknown): { used: number; model: string } | null {
  const { model, usage } = (message ?? {}) as { model?: unknown; usage?: Record<string, unknown> | null };
  if (typeof model !== 'string' || !usage) return null;
  const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
  return { used: tokens.reduce((sum, field) => sum + (typeof usage[field] === 'number' ? (usage[field] as number) : 0), 0), model };
}

// One API message's usage as it streamed, by the message's id. Streamed
// usage carries no cost: the session's totals bring it.
function sampleOf(message: unknown): { messageId: string; model: string; usage: Usage } | null {
  const { id, model, usage } = (message ?? {}) as { id?: unknown; model?: unknown; usage?: Record<string, unknown> | null };
  if (typeof id !== 'string' || typeof model !== 'string' || !usage) return null;
  const count = (field: string) => (typeof usage[field] === 'number' ? (usage[field] as number) : 0);
  return {
    messageId: id,
    model,
    usage: {
      input: count('input_tokens'),
      output: count('output_tokens'),
      cacheRead: count('cache_read_input_tokens'),
      cacheWrite: count('cache_creation_input_tokens'),
      cost: 0,
    },
  };
}

// The session's usage so far, per model, with the client's API-equivalent cost.
function totalOf(runId: string, result: SDKResultMessage): RunEvent {
  const models: ModelUsage = Object.fromEntries(
    Object.entries(result.modelUsage ?? {}).map(([model, used]) => [
      model,
      { input: used.inputTokens, output: used.outputTokens, cacheRead: used.cacheReadInputTokens, cacheWrite: used.cacheCreationInputTokens, cost: used.costUSD },
    ]),
  );
  return { type: 'usageTotaled', runId, models };
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
