---
status: accepted (delegation tool list amended by ADR 0009)
---

# The Claude Agent SDK executes every run, HITL included

Every **run** (a HITL conversation, an AFK stage, a Ralph loop iteration, a delegated child task) is one Claude Agent SDK (TypeScript) `query()` with streaming input, owned by the factory process. We chose it because it is the only surface that covers every need with one code path. It gives in-process MCP tools for delegation, a `canUseTool` callback the factory controls, in-process hooks, per-model usage on every result, and `rate_limit_event` for the **usage window** (research: [What can drive Claude Code runs from TypeScript?](https://github.com/kevinverreault/agents-factory/issues/3), [Where can token and usage-window data be read?](https://github.com/kevinverreault/agents-factory/issues/4)). Decided in [Which executor drives runs?](https://github.com/kevinverreault/agents-factory/issues/9).

## Decisions

- **The factory renders HITL conversations itself.** The operator talks to a HITL run through a factory conversation view fed by the SDK stream. Permission prompts and `AskUserQuestion` reach the operator through `canUseTool` as factory UI. Skills still run from a prompt such as `/grill-with-docs`. v1 does not embed the interactive `claude` terminal. This reverses the orchestrators research gist (node-pty + `@xterm/headless` full-screen attach). For an escape hatch, the operator can reopen a session in their own terminal with `claude --resume <session-id>`.
- **A handoff starts a new run.** A run has exactly one **mode** and one **autonomy level**. A **handoff** ends the HITL run and starts an AFK run that resumes the same conversation with AFK options: no permission prompts, a **budget**, a turn cap, and at L2 the sandbox. We do not switch modes in place with `setPermissionMode`, even though the SDK allows it. An in-place switch cannot move a run into a container, and it would blur per-run metrics.
- **Sandboxed runs use the same executor.** At L2 the factory passes `spawnClaudeCodeProcess`, which runs `docker exec -i <container> claude …`. The SDK protocol travels over that stdio, so the factory's in-process MCP tools, `canUseTool` and hooks keep working across the container boundary. The image pins the same Claude Code version as the SDK's bundled binary.
- **The credential is a per-run input.** The executor applies the credential profile it is given and never chooses one:
  - `subscription-host`: the operator's own `/login`. The factory never reads it and removes `ANTHROPIC_API_KEY` from the environment.
  - `subscription-token`: a `setup-token` value passed as `CLAUDE_CODE_OAUTH_TOKEN`, for containers.
  - `api-key`: the overflow pool, off by default.

  The scheduler picks the profile for each run. A policy change on subscription use then only changes which profile runs get.
- **The SDK is pinned exactly, behind a thin seam.** `@anthropic-ai/claude-agent-sdk` is pinned to an exact version, and the factory uses its bundled binary, never the operator's installed `claude`. Upgrades are deliberate commits. The executor port is small: start a run, send input, interrupt, a stream of run events, and a final result with usage. v1 builds only the SDK adapter.
- **A Windows walking skeleton comes first.** The first build slice runs streaming input, tool calls and `interrupt()` on the operator's Windows 10 machine. Those are the areas of the open SDK issues [#359](https://github.com/anthropics/claude-agent-sdk-typescript/issues/359) (Stream closed) and [#444](https://github.com/anthropics/claude-agent-sdk-typescript/issues/444) (interrupt segfault). If one of them blocks progress, build a `claude -p --input-format stream-json --output-format stream-json` adapter behind the same port.
- **The Vercel AI SDK is not used in v1.** It either skips Claude Code (`@ai-sdk/anthropic`) or wraps an older version of the same Agent SDK (`ai-sdk-provider-claude-code`). Even model calls that are not runs, such as a handoff summary, go through the executor as a cheap run.

## Considered options

- **(b) The native `claude` in a PTY for HITL, the SDK for AFK.** Rejected for v1, and kept as the v2 candidate (see below). Its benefit is the real Claude Code screen during HITL. Its costs are two run paths, a delegation tool that must also run as an out-of-process MCP server, usage-window data only through a status-line relay, and Windows 10 ConPTY quirks.
- **(c) `claude -p` with stream-json for everything.** This is how vibe-kanban works. It loses in-process MCP tools and callbacks. It stays only as the fallback adapter.
- **(d) The Vercel AI SDK as executor.** It adds no capability over the Agent SDK.

## Path to option (b) in v2

The operator wants option (b), the native interactive `claude` for HITL, to stay easy to pick up later. v1 keeps that door open in these ways:

1. **Port, not SDK types.** The rest of the factory sees only the executor port and factory-owned run events, never SDK message types. A PTY adapter is then a second implementation of the same port.
2. **The delegation tool's logic lives outside its transport.** The factory MCP tool handlers (spawn, list and cancel child tasks, report progress and results; ADR 0009. Questions use `AskUserQuestion`, so there is no attention-request tool) are plain functions over the store. `createSdkMcpServer` is one thin binding. For (b), add a second binding as a local stdio or HTTP MCP server and pass it to `claude` with `--mcp-config`.
3. **Attention requests come from hooks, not screen-scraping.** For (b), the PTY session gets settings-file hooks (`Notification`, `Stop`, `PermissionRequest`) that post to the factory. This is the same event vocabulary the SDK adapter emits from `canUseTool` and in-process hooks.
4. **Usage window behind a port.** The scheduler reads usage-window snapshots through a port. For (b), add a status-line script that relays `rate_limits.five_hour` / `seven_day` to the factory. Token metrics come from the transcript's `cost-state` record or the next SDK run, because a PTY session has no `result` message.
5. **Handoff already resumes by session id.** A handoff is "end run, start a new run that resumes the session", so a PTY HITL run hands off the same way: end the PTY, then the SDK resumes `--resume <session-id>`. Verify the round trip between an SDK-created session and the interactive `claude` first.
6. **Terminal embedding is already researched.** Use node-pty 1.1 with its bundled `conpty.dll` (`useConptyDll: true`), plus `@xterm/headless` 6 with `@xterm/addon-serialize`, attached full-screen as ccmanager does. Spawn with `TERM=xterm-256color` and `COLORTERM=truecolor`, reset key protocols on attach and detach, and leave `conptyInheritCursor` off. See the research on `research/orchestrators-and-tui` ([Which orchestrators and TUI building blocks can be reused?](https://github.com/kevinverreault/agents-factory/issues/6)).

## Consequences

- The conversation view and the permission and question prompts are factory UI that v1 must build. They are not inherited from Claude Code.
- Subscription use stays a policy risk: the docs ask SDK developers to use API keys. The per-run credential profile is the hedge ([Which Claude billing path fits the factory?](https://github.com/kevinverreault/agents-factory/issues/2)).
- `env` in the SDK options replaces the child environment rather than merging it, so the adapter must spread `process.env`. On Windows, `PATH`, `USERPROFILE` and `APPDATA` must survive. Pass `permissionMode` explicitly, because the default depends on the CLI.
