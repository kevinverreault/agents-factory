# What can drive Claude Code runs from TypeScript?

Research for issue #3 (map: #1 "Agent factory v1"). Researched 2026-10-14.

## Answer in brief

There is really one engine with three ways to reach it:

1. **Claude Agent SDK for TypeScript** (`@anthropic-ai/claude-agent-sdk`). An npm library that spawns the Claude Code native binary (bundled per platform, `win32-x64` included) and talks to it over a stdio control protocol. It exposes everything the factory needs: a live, long-lived session with streaming input; mid-session `setPermissionMode` / `setModel` / `interrupt`; resume and fork; per-run and per-subagent model choice; programmatic `canUseTool` and in-process hook callbacks; **in-process MCP tools** (`createSdkMcpServer`); per-message usage, per-model cost on every result, and **subscription rate-limit events** (5-hour and 7-day windows).
2. **The `claude` CLI headless mode** (`claude -p`). It runs the same engine, but you get only what flags and stream-json carry. Multi-turn stdin (`--input-format stream-json`), resume and fork, `--model`, permission modes, `--allowedTools`, settings-file hooks, and the same usage and cost on results are all there. It has **no in-process MCP tools**, so delegation would need a separate stdio or HTTP MCP server. It has no in-process permission callback either: you get `--permission-prompt-tool` (an MCP tool), or you speak the SDK's internal control protocol yourself.
3. **Vercel AI SDK.** The first-party `@ai-sdk/anthropic` provider is a raw Messages API client. It does not run Claude Code (no built-in tools, CLAUDE.md, skills or hooks), and it takes only an API key or bearer token. The community `ai-sdk-provider-claude-code` (by Ben Vargas, MIT) is a **thin wrapper over the Agent SDK**. It pins an older SDK (0.3.283 against the current 0.3.300) and fits Claude Code into the AI SDK's request/response shape. Each `generateText`/`streamText` call is one SDK `query()`, and the provider closes streaming input when the result arrives. A live HITL session therefore spans a single call, and AI SDK `tools` cannot be used as Claude Code tools without bridging them through MCP.

**What this means for the executor:** the Agent SDK is the only surface that covers every requirement without a sidecar. The CLI is a workable fallback but needs an out-of-process MCP server for delegation and loses typed callbacks. The Vercel AI SDK adds no capability here: the Anthropic provider skips Claude Code entirely, and the Claude Code provider wraps the same SDK one version behind with less control. The open risk is **policy, not capability**. Anthropic's docs tell third-party developers building on the Agent SDK to use API keys, and they say Pro/Max limits assume "ordinary, individual usage of Claude Code and the Agent SDK". See [Subscription auth](#subscription-login-auth-vs-api-key).

## Versions examined

| Artifact | Version | How checked |
| - | - | - |
| `@anthropic-ai/claude-agent-sdk` | 0.3.300 (published 2026-10-14), `claudeCodeVersion: 2.1.300` | `npm view`; tarball unpacked, `sdk.d.ts` and `package.json` read |
| `@anthropic-ai/claude-code` / installed `claude` | 2.1.300 | `npm view`, `claude --version` |
| `ai` (Vercel AI SDK) | 7.0.140 | `npm view` |
| `@ai-sdk/anthropic` | 4.0.79 | `npm view` |
| `ai-sdk-provider-claude-code` | 4.3.3 (AI SDK v7; depends on `@anthropic-ai/claude-agent-sdk` **0.3.283**) | tarball unpacked, `package.json`, `README.md`, `dist/index.d.ts` read |

The ai-sdk.dev community-provider page still describes provider 3.x for AI SDK v6. The package's own README is newer and authoritative (4.x targets v7).

## How each surface works

- **Agent SDK.** The official overview says it is "a library that runs the Claude Code binary, with Claude Code's capabilities, such as built-in tools, permissions, sessions, and hooks" ([overview](https://code.claude.com/docs/en/agent-sdk/overview)). The package lists the native binaries as `optionalDependencies` for `win32-x64`, `win32-arm64`, `darwin-*` and `linux-*`, and you can override the binary with `pathToClaudeCodeExecutable` (`package.json`, `sdk.d.ts` `Options`). Callbacks (`canUseTool`, `hooks`, SDK MCP tools) run in **your** Node process. The binary calls back over the control channel.
- **CLI `-p`.** The docs describe it as "using the Agent SDK via the CLI" ([headless](https://code.claude.com/docs/en/headless)). The SDK uses the same stream-json protocol (`--input-format stream-json --output-format stream-json`), but only the message formats and flags are documented for CLI users. The control-request side (`can_use_tool`, `interrupt`, `set_permission_mode`, …) appears only as SDK internals, for example `SDKControl*` types in `sdk.d.ts`. **Not verified:** whether driving the control protocol directly from your own code is supported.
- **Vercel `@ai-sdk/anthropic`.** It calls the Anthropic Messages API directly. You write the agent loop, tools and permissions yourself ([provider docs](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)).
- **Vercel `ai-sdk-provider-claude-code`.** "lets you use Claude via the Vercel AI SDK through the official `@anthropic-ai/claude-agent-sdk` and the Claude Code CLI" (package README). It re-exports SDK types and helpers and passes most SDK options through, plus an `sdkOptions` escape hatch.

## Comparison table

Legend: **Yes** = documented and typed. **Partial** = possible with caveats. **No** = not available. Unverified items are marked _(unverified)_.

| Dimension | Agent SDK (TS) 0.3.300 | `claude -p` 2.1.300 | `@ai-sdk/anthropic` 4.0.79 | `ai-sdk-provider-claude-code` 4.3.3 |
| - | - | - | - | - |
| Runs the Claude Code harness (tools, CLAUDE.md, skills) | Yes | Yes | **No**, Messages API only | Yes (via Agent SDK) |
| Streaming input / multi-turn live session | **Yes**: `prompt: AsyncIterable<SDKUserMessage>`, `streamInput()`, queued messages, images | Yes: `--input-format stream-json` keeps stdin open | N/A (you own the loop) | **Partial**: streaming input lives only for one `generateText`/`streamText` call ("the provider closes streaming input when the terminal result arrives"); inject mid-call via `onStreamStart` |
| Switch live session to unattended | **Yes**: `setPermissionMode()`, `applyFlagSettings()`, `setModel()`; the `canUseTool` policy is host code, so it can change at any time | Partial: only by speaking the control protocol (`set_permission_mode`) _(unverified as a supported use)_, or by ending the process and `--resume` with new flags | N/A | Partial: via `onQueryControllerCreated` / raw `Query` during a call; otherwise a new call with `resume` |
| Resume / continue | Yes: `resume`, `continue`, `resumeSessionAt`, `sessionId`; `listSessions()`, `getSessionMessages()` | Yes: `--resume <id\|name\|path>`, `--continue`, `--session-id` | No | Yes: `resume`, `sessionId`, `forkSession` passthrough; session ID in `providerMetadata['claude-code'].sessionId` |
| Fork | Yes: `forkSession: true`, `forkSession()` helper | Yes: `--fork-session` | No | Yes |
| Per-run model | Yes: `model`, `fallbackModel`, mid-session `setModel()` | Yes: `--model`, `--fallback-model`, `/model x` in prompt | Yes (it is the API) | Yes: `claudeCode('opus'\|'sonnet'\|'haiku'\|id)` |
| Subagents | Yes: `agents: Record<string, AgentDefinition>` with per-agent `model`, `tools`, `mcpServers`, `skills`, `maxTurns`; `agent` for the main thread; task events | Yes: `--agents <json\|file>`, `--agent`, `--forward-subagent-text` | No | Yes (passthrough; `onTaskEvent`, parent/child IDs in metadata) |
| Hooks | **Yes, in-process callbacks**: `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>`, 33 events incl. PreToolUse, PostToolUse, Stop, SubagentStart/Stop, PermissionRequest, SessionStart/End; also settings-file hooks | Settings-file (shell command) hooks only, via `--settings` or project files; `--include-hook-events` | No | Yes (passthrough of SDK callbacks) |
| Permission modes | Yes: `default`, `acceptEdits`, `bypassPermissions` (needs `allowDangerouslySkipPermissions`), `plan`, `dontAsk`, `auto` | Yes: `--permission-mode` (same set) | N/A | Yes (passthrough) |
| Programmatic permission callback | **Yes**: `canUseTool(toolName, input, {signal, suggestions, …}) → allow\|deny` with `updatedInput` / `updatedPermissions`; `permissionPrompts: 'host'\|'none'` | Partial: `--permission-prompt-tool <mcp tool>`; `--permission-prompts none` | N/A | Yes: `canUseTool` (forces streaming input) |
| Allowed / disallowed tools | Yes: `tools`, `allowedTools`, `disallowedTools`, `toolAliases` | Yes: `--tools`, `--allowedTools`, `--disallowedTools` | N/A | Yes |
| Custom **in-process** MCP tools | **Yes**: `tool()` + `createSdkMcpServer()` passed in `mcpServers`; "runs in-process inside your application"; `setMcpServers()` at runtime | **No**: only external servers via `--mcp-config` (stdio/SSE/HTTP) | MCP connector to remote URLs only (server-side) | Yes: SDK servers pass through; `createAiSdkMcpServer` bridges AI SDK tools |
| Usage per message | Yes: each `SDKAssistantMessage.message.usage` (dedupe by `message.id`; `output_tokens` is a placeholder) | Yes, same objects in stream-json | Yes: `usage` incl. cache read/write | Yes: AI SDK `usage` (+ raw) |
| Usage / cost per result | Yes: `total_cost_usd`, `usage` (main loop only), `modelUsage` per model (incl. subagents), `num_turns`, `duration_*`, `permission_denials` | Yes, same `result` object (`--output-format json\|stream-json`) | Tokens only, no cost | `providerMetadata['claude-code'].costUsd`, timings |
| Subscription quota signals | **Yes**: `rate_limit_event` messages (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, utilization, `resetsAt`); `usage_EXPERIMENTAL_…()` for `/usage` data; `accountInfo()` | `rate_limit_event` in stream-json _(inferred from shared types, not separately verified)_ | No | Not surfaced as a first-class field _(unverified)_ |
| Subscription (`/login`) auth | Technically yes (the binary reads its own stored login), **policy-restricted**, see below | Yes: documented default for Pro/Max; `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` for scripts | **No**: `apiKey` / `authToken` only | Advertised as "use Pro/Max subscription", same policy caveat |
| Skills / `SKILL.md` | Yes: loaded from `.claude/skills` and `~/.claude/skills` per `settingSources`; `skills: 'all' \| string[]`; `reloadSkills()` | Yes (not with `--bare`, which skips them except `--add-dir` skills); `/skill-name` in prompt works | Only Anthropic "container skills" via code execution | Yes: `skills`, `settingSources` passthrough |
| Plugins | Yes: `plugins: [{type:'local', path}]`, `pluginDelivery: 'initialize'`, `reloadPlugins()` | Yes: `--plugin-dir`, `--plugin-url` | No | Yes (local paths) |
| Windows | Yes: bundled `win32-x64` binary; some open bugs (below) | Yes: native Windows 10 1809+; Git Bash optional, PowerShell tool otherwise | Platform-neutral (HTTP) | Node ≥ 22; inherits SDK behavior |

## Details by dimension

### Streaming input, HITL, and the switch to AFK

- Streaming input is "the **preferred** way to use the Claude Agent SDK … a long lived process that takes in user input, handles interruptions, surfaces permission requests". Single-message mode does not support "Dynamic message queueing", "Real-time interruption" or "Natural multi-turn conversations" ([streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)).
- `Query` control methods are "only supported when streaming input/output is used": `interrupt()`, `setPermissionMode(mode)`, `setModel(model?)`, `applyFlagSettings(settings)` (effort, permissions, model mid-session), `streamInput()`, `stopTask()`, `backgroundTasks()`, `setMcpServers()`, `close()` (`sdk.d.ts`, `interface Query`).
- TypeScript has **no session-holding client object**. The V2 `createSession()` preview "was removed in TypeScript Agent SDK 0.3.142" ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)). A live HITL session is one `query()` fed by your own async generator. A TUI pushes operator input into a queue that the generator drains.
- **Handoff HITL → AFK:** you can keep the process and change policy, or restart it:
  - In place: `setPermissionMode('auto' | 'dontAsk' | 'acceptEdits')`, and change what your `canUseTool` does (it is your code, so it can route to the TUI in HITL and decide automatically in AFK). `permissionPrompts: 'none'` exists as a query option only (no runtime setter found in `Query`).
  - Restart: end the HITL `query()` and start a new one with `resume: sessionId` and AFK options (`permissionMode: 'auto'`, `permissionPrompts: 'none'`, `maxBudgetUsd`, `maxTurns`). The conversation carries over. Spend totals restore from the transcript ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).
- CLI: `--permission-prompts none` "when nobody is available to answer permission prompts … Anything that would prompt is denied unless a `PermissionRequest` hook allows it", and it removes `AskUserQuestion` ([headless](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs)). Requires v2.1.259+.
- Stopping cleanly: SIGTERM leaves the in-flight turn unfinished with exit 143. "To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`" ([headless](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)). `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` resumes an interrupted turn.

### Resume and fork

- `resume` takes a session ID. `continue` takes the most recent session in the cwd. `forkSession: true` makes a new ID from a copy of the history. `resumeSessionAt` truncates to a message UUID ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions); `Options` in `sdk.d.ts`).
- Storage: `~/.claude/projects/<encoded-cwd>/*.jsonl` (or under `CLAUDE_CONFIG_DIR`). Resume by ID searches all projects on the machine (v2.1.223+). Resume is "same machine only" unless you use a `SessionStore` adapter (alpha) ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)).
- Forking branches **conversation only, not files**: "If a forked agent edits files, those changes are real". File rewind needs `enableFileCheckpointing` + `rewindFiles()` ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)).
- `claude --continue` "Skips sessions created with `claude -p` or the Agent SDK" in interactive mode ([CLI reference](https://code.claude.com/docs/en/cli-reference)). `--resume <id>` still opens them. **Not verified:** a full round trip of an SDK-created session opened in the interactive TUI.

### Model choice and subagents

- `model` accepts aliases (`opus`, `sonnet`, `haiku`, `fable`, `best`, `opusplan`) or full IDs. On the Anthropic API, aliases resolve to Opus 5.5 / Sonnet 5.5 / Haiku 5.5, and "Pro, Max, Team, Enterprise, and Anthropic API: defaults to Opus 5.5" ([model config](https://code.claude.com/docs/en/model-config)). Not every model is available on every plan (for example, Fable may bill usage credits), and the page gives no full per-plan matrix _(unverified for Pro)_.
- `AgentDefinition.model`: "Model alias … or full model ID … 'inherit' uses the main model" (`sdk.d.ts`). Subagents can also take their own `tools`, `disallowedTools`, `mcpServers`, `skills`, `maxTurns` and `autoCompactWindow`.
- `PreModelSwitch` / `PostModelSwitch` hooks report `estimated_cache_write_usd` and `prompt_cache_warm`. A mid-session model switch forfeits the prompt cache (`sdk.d.ts`).

### Hooks and permissions

- SDK hooks are in-process async callbacks keyed by `HookEvent` (33 events in 0.3.300: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `FileChanged`, … per `HOOK_EVENTS` in `sdk.d.ts`). Hooks from settings files also run unless `settingSources: []`.
- `canUseTool` returns `{behavior:'allow', updatedInput?, updatedPermissions?}` or `{behavior:'deny', message, interrupt?}`. Returning `null` by mistake "means no control_response is sent and the tool stays blocked indefinitely — permission prompts have no park deadline" (`sdk.d.ts`).
- `permissionMode` default: "When omitted, Claude Code picks the starting mode as it does for `claude -p` … else `'auto'` where that is the default". **Pass it explicitly** (`sdk.d.ts`; [headless](https://code.claude.com/docs/en/headless#auto-approve-tools)).
- `-p` without `--bare` "runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted" ([headless](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)). This matters for worktrees of untrusted repos. SDK equivalents: `settingSources`, `strictMcpConfig`, `projectConfigRoot`.

### In-process MCP tools (for agent-initiated delegation)

- `tool(name, description, zodShape, handler)` + `createSdkMcpServer({name, tools})`, passed in `mcpServers`. Tools are named `mcp__{server}__{tool}`. "The server runs in-process inside your application, not as a separate process" ([custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)). A `spawn_child_task` handler can therefore write directly to the factory's store and scheduler, with no IPC.
- Uncaught handler exceptions become error results, and the agent loop continues. Per-server `timeout`, else `MCP_TOOL_TIMEOUT`, else "effectively unbounded" (`sdk.d.ts` `createSdkMcpServer`).
- Tool search is on by default and defers SDK MCP tool schemas. Use `alwaysLoad: true` to keep one in the prompt ([custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)).
- `canUseTool` receives `mcp_server.source: 'sdk'` for host-registered servers, so the factory can tell its own tools from configured ones (`sdk.d.ts`).
- CLI-only alternative: run the factory MCP server as a local HTTP or stdio server and pass it with `--mcp-config` (`-p` waits up to `MCP_TIMEOUT`, 30 s, for it to connect) ([CLI reference](https://code.claude.com/docs/en/cli-reference)).

### Usage and cost

- Per step: `SDKAssistantMessage.message.usage`. Parallel tool calls share an ID, so dedupe. "Per-step `output_tokens` is a placeholder", so read output tokens from the result ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).
- Per result: `total_cost_usd` and `modelUsage` (per model: input, output, thinking, cacheRead, cacheCreation, webSearchRequests, costUSD, contextWindow) include subagents. `usage` is "MAIN AGENT LOOP ONLY". In streaming-input mode each turn emits a result, and `total_cost_usd`/`modelUsage` are **running totals**: "read the latest result rather than summing" (`sdk.d.ts`).
- Cost figures "are client-side estimates, not authoritative billing data" ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)). Under a subscription they are notional dollars. Tokens and the rate-limit events are the meaningful signals.
- Subscription quota: `SDKRateLimitEvent` ("Rate limit information for claude.ai subscription users") with `status` (`allowed`/`allowed_warning`/`rejected`), `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, …), `utilization` and `resetsAt`. `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` returns `/usage` data including 5-hour and 7-day windows. It is explicitly unstable (`sdk.d.ts`). Relevant to the quota-aware scheduler.
- Crash results may carry zeroed cost. Recover from the previous turn's result ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking#recover-totals-after-a-session-crash)).

### Subscription (`/login`) auth vs API key

- **Mechanics.** Credential precedence: cloud provider → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → Anthropic profile → `/login` subscription OAuth. "`apiKeyHelper`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` apply to the CLI and the surfaces that wrap it, including … the Agent SDK". In `-p`, an `ANTHROPIC_API_KEY` that is present is always used. On Windows the login lives in `%USERPROFILE%\.claude\.credentials.json`. `claude setup-token` mints a one-year subscription token for scripts ([authentication](https://code.claude.com/docs/en/authentication)). `--bare` "never reads OAuth credentials", so it needs an API key ([headless](https://code.claude.com/docs/en/headless)).
- **Policy.** The Agent SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" ([overview](https://code.claude.com/docs/en/agent-sdk/overview)). The legal page adds that "Developers building products or services … including those using the Agent SDK, should use API key authentication", and that developers "may not collect, store, or intermediate Claude.ai credentials or session tokens". It also says the policy does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", and that "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK" ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- **Reading (not verified with Anthropic):** a personal, local factory where the operator signs in to the unmodified binary through `/login` and the factory never handles tokens looks closer to "an end user signing in … with their own subscription" than to a product offering claude.ai login. Heavy parallel AFK use may still exceed "ordinary, individual usage". The factory should keep auth swappable (subscription ↔ `ANTHROPIC_API_KEY`) and never read or copy `.credentials.json`. The billing research ticket should confirm this.
- Vercel `@ai-sdk/anthropic` accepts only `apiKey` (`x-api-key`) or `authToken` (Bearer). Subscription OAuth is not mentioned ([provider docs](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)). Putting a claude.ai token there would be exactly the "intermediate … session tokens" case the policy forbids.

### Skills and plugins

- The SDK loads skills, commands and memory from `.claude/` and `~/.claude/` "same as Claude Code" ([overview](https://code.claude.com/docs/en/agent-sdk/overview)). `settingSources` controls which (omitted = all; `[]` = isolation; must include `'project'` for CLAUDE.md). `skills: 'all' | string[]` is "a context filter, not a sandbox" (`sdk.d.ts`).
- Plugins: "Currently only local plugins are supported via the 'local' type". On Windows, use `pluginDelivery: 'initialize'` to avoid the 32,767-character command-line limit with many plugins (`sdk.d.ts`). `skipMcpDiscovery` lets the host own a plugin's MCP servers.
- `projectConfigRoot` makes project settings, hooks, `.mcp.json` and `.claude` (skills, agents, commands) come from a **trusted checkout** while `cwd` is a worktree (`sdk.d.ts`). This fits per-run worktrees and skill pinning.
- CLI `-p`: "User-invoked skills and custom commands work. Include `/skill-name` in the prompt string". `/login` is not available ([headless](https://code.claude.com/docs/en/headless)).

### Windows support and known quirks

- Claude Code supports Windows 10 1809+ / Server 2019+. Native Windows has **no sandboxing** (WSL 2 does). Without Git for Windows, shell commands go through the PowerShell tool. `CLAUDE_CODE_GIT_BASH_PATH` points at Git Bash ([setup](https://code.claude.com/docs/en/setup#set-up-on-windows)). A startup refusal `shell_tool_missing` exists for "Git Bash is missing, and PowerShell is missing or turned off" (`sdk.d.ts`).
- SDK fixes from the changelog ([CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)): console-window flashes when spawning on Windows (fixed), resume temp-dir leak on Windows (fixed), `listSessions`/`getSessionInfo` with `dir` on mapped or SUBST drives (fixed), `pluginDelivery: 'initialize'` added "fixes Windows start failures with many plugins".
- Open SDK issues (user-reported, not reproduced here):
  - [#444](https://github.com/anthropics/claude-agent-sdk-typescript/issues/444): `interrupt()` right after `system/init` segfaults `claude.exe`.
  - [#507](https://github.com/anthropics/claude-agent-sdk-typescript/issues/507): `forkSession` can't find sessions when `dir` is an 8.3 short path.
  - [#359](https://github.com/anthropics/claude-agent-sdk-typescript/issues/359): intermittent "Stream closed" after the first tool call on Windows.
  - Cross-platform but relevant: [#384](https://github.com/anthropics/claude-agent-sdk-typescript/issues/384) (`canUseTool` channel closes while background subagents still run), [#465](https://github.com/anthropics/claude-agent-sdk-typescript/issues/465) (`SessionStart` hook callback doesn't fire in streaming-input sessions), [#219](https://github.com/anthropics/claude-agent-sdk-typescript/issues/219) (MCP server processes left as zombies).
- `env` in `Options` **replaces** the subprocess environment rather than merging it, so spread `process.env` (`sdk.d.ts`). On Windows, `PATH`, `USERPROFILE` and `APPDATA` must survive.
- Unreadable stdin "on Windows crashed the session or made it exit silently" before v2.1.211, fixed ([headless](https://code.claude.com/docs/en/headless)).

## What this implies for the executor choice (for #9 / #15)

- **Default to the Agent SDK `query()` with streaming input** as the single run driver: HITL and AFK are the same session with different permission policy, and handoff is `setPermissionMode` plus a host-side `canUseTool` policy switch, or `resume` in a new process.
- **The factory MCP tool belongs in-process** (`createSdkMcpServer`), so delegation, depth and budget checks hit the factory store directly.
- **Read metrics from `result.modelUsage` (latest per run) and `rate_limit_event`**. Treat `total_cost_usd` as notional under a subscription.
- **Pin the SDK version.** The SDK ships almost daily and carries a matching CLI build (`claudeCodeVersion`). Behavior changes land in patch releases (for example 0.3.300 changed `updatedInput` validation).
- Use Vercel AI SDK only for **non-Claude-Code** model calls (for example, a cheap classifier or summary inside the factory), and only with an API key.
- Keep a thin adapter seam so a CLI `-p` driver can replace the SDK if a Windows SDK bug blocks progress. Most capabilities carry over, minus in-process tools and callbacks.

## Not verified / open questions

- Policy fit of a personal SDK-based factory on a Pro subscription. The docs are ambiguous for this case. Confirm with Anthropic support or move to the API, and hand this to the billing ticket.
- Whether `rate_limit_event` appears in raw `claude -p --output-format stream-json` output. Inferred from shared types, not observed.
- Whether driving the stream-json **control protocol** directly (without the SDK) is a supported public interface.
- A full round trip of an SDK-created session reopened in the interactive `claude` TUI (`--resume <id>`). Docs imply yes; not tested.
- No live run was made in this research (no SDK `query()` against the operator's subscription). All behavior comes from docs and the typings in the published package.

## Sources

- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Streaming input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Custom tools: https://code.claude.com/docs/en/agent-sdk/custom-tools
- Cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Headless / `-p`: https://code.claude.com/docs/en/headless
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Authentication: https://code.claude.com/docs/en/authentication
- Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Model configuration: https://code.claude.com/docs/en/model-config
- Setup (Windows): https://code.claude.com/docs/en/setup
- SDK package: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk (0.3.300; `sdk.d.ts`, `README.md`, `package.json` read from the tarball)
- SDK repo and changelog: https://github.com/anthropics/claude-agent-sdk-typescript, https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- Vercel AI SDK Anthropic provider: https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- Vercel AI SDK community Claude Code provider: https://ai-sdk.dev/providers/community-providers/claude-code
- `ai-sdk-provider-claude-code` package: https://github.com/ben-vargas/ai-sdk-provider-claude-code (4.3.3; `README.md`, `dist/index.d.ts` read from the tarball)
