# Where can token and usage-window data be read?

Research for issue #4 (map #1, "Agent factory v1"). Researched 2026-10-14 against Claude Code **v2.1.300** (installed on the operator's Windows machine), Agent SDK (TypeScript) **v0.3.300** and ccusage **v20.0.33**. Claims marked **[observed]** come from local probes on this machine (Pro subscription, `/login`). Claims marked **[unverified]** are inferences with no primary source behind them.

## Answer

- **Per-run tokens:** read the `result` message from the stream that the factory already consumes (Agent SDK `query()` or `claude -p --output-format stream-json`). Use `modelUsage`, which is per model, includes subagents, and covers input, output, cache-read and cache-write tokens, plus `costUSD`. It is documented, typed, and arrives the moment the run ends. For live progress during a run, add deduplicated per-step `assistant.message.usage`, but take output tokens only from the result.
- **Usage-window consumption:** the only machine-readable source inside a headless run is the `rate_limit_event` message in the same stream. On a subscription it reports `status`, `resetsAt` and `rateLimitType`. **[observed]** On v2.1.300 it also carries an untyped `unifiedWindows` object with `five_hour` and `seven_day` utilization (0–1) and reset times. This object is not in the SDK types, so it may change without notice. The documented and stable source is the **status line** JSON (`rate_limits.five_hour` / `seven_day`, `used_percentage` 0–100, `resets_at`), but it only reaches interactive sessions. OpenTelemetry has **no** usage-window metric.
- **Before a run** (the scheduler's pre-run check), no documented, cost-free API exists. The practical design is to cache the latest window snapshot from the last run's `rate_limit_event` (and from any interactive session's status line), along with its `resetsAt`. Treat the snapshot as stale once it ages or its reset time has passed.
- **Do not build on** the transcript JSONL (its format is internal and changes between versions), ccusage (heuristic 5-hour blocks rebuilt from transcripts), or the OAuth usage endpoint behind `/usage` (undocumented).

## Source by source

### 1. Agent SDK / `claude -p` stream: result message (recommended for tokens)

Primary sources: [Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), `sdk.d.ts` in `@anthropic-ai/claude-agent-sdk@0.3.300`.

- **Fields on the result message** (`type: "result"`, both success and error subtypes): `total_cost_usd`, `usage` (`NonNullableUsage`), `modelUsage: {[model]: ModelUsage}`, `duration_ms`, `duration_api_ms`, `num_turns`, `session_id`.
- **`ModelUsage`:** `inputTokens`, `outputTokens`, `thinkingTokens?` (already included in `outputTokens`), `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel?`, `provider?`, `costBasis?` (`list` / `managed` / `unknown`, from v2.1.246).
- **`Usage` (per API response):** `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `server_tool_use`, `service_tier`, `speed`, `inference_geo`. `input_tokens` excludes cache tokens. **[observed]** v2.1.300 also emits `output_tokens_details.thinking_tokens`, `iterations[]` and `fallback_credit`.
- **Scope rules that matter for a factory:**
  - `usage` covers only the **main loop**, so it misses subagents. `total_cost_usd` and `modelUsage` include subagents. Account from `modelUsage`.
  - A run that **resumes** a session reports the session's whole total, including earlier runs (from v2.1.277), so read the latest result and do not sum. Independent runs each cover only themselves.
  - In streaming-input mode each turn emits a result whose `total_cost_usd` and `modelUsage` are running totals, and `/clear` resets them (`SDKConversationResetMessage`).
  - On a **crash**, the final `error_during_execution` result may carry zeroed cost fields. Recover from an earlier result, or by summing per-step input and cache usage. Output tokens and subagent usage cannot be recovered that way.
  - On `error_max_budget_usd`, `usage` leaves out the last response, but `total_cost_usd` and `modelUsage` include it.
- **Per-step usage:** each `assistant` message carries `message.id` and `message.usage`. Parallel tool calls produce several messages with the **same id and identical usage**, so deduplicate by id. Per-step `output_tokens` is a **placeholder** (the `message_start` count), so read real output from the result. For a live output count, use `includePartialMessages` and `message_delta` stream events. Subagent messages carry a non-null `parent_tool_use_id`.
- **Cost is an estimate:** it is computed client-side from a price table bundled at build time. The docs say: "Do not bill end users or trigger financial decisions from these fields." On a Pro or Max subscription the dollar figure is notional, but token counts are what matter for the factory's metrics.
- **Granularity / timeliness / stability:** per API response (step), per run (result), per model. Real-time in the stream. It is a documented, typed public interface and the most stable option.
- **[observed]** The result also carries `subagent_stats` (spawned, completed, failed, refused by depth, concurrency or budget limits), which is useful for task-tree metrics. It is not documented in the reference page, so treat it as unstable.
- Windows and Mac: identical, since it is in-process stream data.

### 2. Agent SDK / `claude -p` stream: `rate_limit_event` (only in-run window source)

Primary sources: TypeScript SDK reference (`SDKRateLimitEvent`), `sdk.d.ts` v0.3.300 (`SDKRateLimitInfo`, commented "Rate limit information for claude.ai subscription users").

- **Typed fields:** `status` (`allowed` | `allowed_warning` | `rejected`), `resetsAt?` (epoch seconds), `rateLimitType?` (`five_hour` | `seven_day` | `seven_day_opus` | `seven_day_sonnet` | `seven_day_overage_included` | `overage`), `utilization?`, `overageStatus?`, `overageResetsAt?`, `overageDisabledReason?`, `isUsingOverage?`, `surpassedThreshold?`, `errorCode?: "credits_required"`, and others.
- **[observed]** A trivial `claude -p --output-format stream-json --verbose` run on Pro emitted one `rate_limit_event` per turn, even with `status: "allowed"`. The docs only say it is "emitted when the session encounters a rate limit." The event had `rateLimitType: "five_hour"` and `resetsAt`, but **no top-level `utilization`**. It also had an **untyped** `unifiedWindows: { five_hour: {utilization, resetsAt}, seven_day: {utilization, resetsAt} }` with utilization as a 0–1 fraction. Two runs a minute apart showed five-hour utilization moving from 0.44 to 0.45.
- **Granularity / timeliness:** account-wide (the window is shared with claude.ai chat and other devices), refreshed on each API response. It is only available while a run is in progress.
- **Stability:** `status`, `resetsAt` and `rateLimitType` are typed and documented. `utilization` is typed but was absent in the probe. `unifiedWindows` is undocumented (**[unverified]** that it will persist). Parse it defensively and fall back to `status` and `resetsAt`.
- **[unverified]** Behaviour with an API key or other providers: the type comment says the event is for claude.ai subscription users, so expect it to be absent or different under API-key billing.

### 3. Status line JSON input (documented window data, interactive only)

Primary source: [Customize your status line](https://code.claude.com/docs/en/statusline).

- **Token and cost fields:** `cost.total_cost_usd` (estimate; resets on `/clear` from v2.1.211), `cost.total_duration_ms`, `cost.total_api_duration_ms`, and `context_window.{total_input_tokens, total_output_tokens, context_window_size, used_percentage, remaining_percentage, current_usage}`. These describe the **context window** from the last response, not a cumulative token count. The input also carries `prompt_cache` (from v2.1.251), `session_id` and `transcript_path`.
- **Window fields:** `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` (0–100), and `rate_limits.*.resets_at` (epoch seconds). Per the docs they appear "only for claude.ai Pro and Max subscribers … and only after the first API response in the session". Each window may be absent, and a window is dropped once `resets_at` passes.
- **Use for the factory:** this is the only *documented* percentage feed. The status line runs only in an interactive TUI session, so it helps only when the factory runs agents interactively, for example a HITL session embedded in a terminal. A status-line script could append the snapshot to a file that the factory reads. **[unverified]** Whether the status line command runs for `-p`, SDK, or background (agent view) sessions. Assume it does not.

### 4. OpenTelemetry metrics and events (good for export, not for windows)

Primary source: [Monitoring (OpenTelemetry)](https://code.claude.com/docs/en/monitoring-usage).

- Enable with `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` (`otlp`, `prometheus`, `console`) and `OTEL_EXPORTER_OTLP_*`. These can be set per child process.
- **Metrics:** `claude_code.token.usage` (attribute `type` = `input` / `output` / `cacheRead` / `cacheCreation`, plus `model`, `query_source`, `effort`, and attribution attributes such as `agent.name` and `skill.name`), and `claude_code.cost.usage` (USD, estimate). Both are incremented after each API request but **exported every 60 s by default** (`OTEL_METRIC_EXPORT_INTERVAL`), with delta temporality.
- **Event `claude_code.api_request`:** `model`, `input_tokens` (excluding cache), `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `cost_usd_micros`, `duration_ms`, `request_id`, `query_source`, `speed`, `effort`. Logs export every 5 s by default. Join keys are `session.id`, `prompt.id`, `request_id` and `message.uuid`.
- **Window data:** none. No metric or event reports rate-limit status or usage-window consumption. A full search of the page found nothing.
- **Fit:** it needs an OTLP collector (or a Prometheus scrape per process), which is overkill for v1 in-TUI metrics because the stream already carries the same numbers. It suits the open "metrics export to a local Grafana" question on the map. It is a documented and stable interface.

### 5. Session transcript JSONL (`~/.claude/projects`)

Primary source: [Manage sessions, Where transcripts are stored](https://code.claude.com/docs/en/sessions). Schema confirmed by reading field names in local files (no content copied).

- **Path:** `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working directory with non-alphanumerics replaced by `-` (on Windows, `C:\Users\<user>\.claude\projects\…`). It can be moved with `CLAUDE_CONFIG_DIR` and named with `CLAUDE_CODE_PROJECT_DIR_NAME` (from v2.1.234). Subagents write to `<session-id>/subagents/agent-<id>.jsonl` with a sibling `.meta.json` file (**[observed]**). Retention is 30 days by default (`cleanupPeriodDays`).
- **[observed] Usage fields:** `assistant` records carry `message.id`, `message.model`, `message.usage` (the same `Usage` shape as the API, including `cache_creation.ephemeral_1h/5m_input_tokens`, `output_tokens_details.thinking_tokens` and `speed`), `requestId`, `timestamp`, `sessionId`, `isSidechain` and `version`. Several records share one `message.id` (one per content block, with identical usage), so deduplicate by `message.id` plus `requestId`, as ccusage does.
- **[observed]** A `cost-state` record with `totalCostUSD`, `totalAPIDuration`, `modelUsage` (per-model `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `costUSD`) and `startTime` is written when the process exits normally. This is the "session's totals saved to its transcript" that the cost-tracking docs mention, and it is what a resumed run restores.
- **No rate-limit or window records** were found in local transcripts.
- **Stability:** the docs state the entry format "is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release." Use it only as a recovery or backfill source, for example after a crash where the stream result was zeroed, or for runs the factory did not launch.

### 6. ccusage (community)

Primary source: [ccusage/ccusage](https://github.com/ccusage/ccusage) (moved from `ryoppippi/ccusage`, now Rust; v20.0.33, 2026-10-14). See `rust/adapters/claude/src/{paths,lib}.rs` and `rust/crates/ccusage/src/blocks.rs`.

- It reads the same transcript JSONL from `CLAUDE_CONFIG_DIR`, `$XDG_CONFIG_HOME/claude` and `~/.claude`. It deduplicates by `message.id` plus `requestId` plus session, keeps the entry with the larger token total, and prefers main-chain entries over sidechain ones. It computes cost from its own pricing table, or uses a recorded `costUSD`.
- The "blocks" report (5-hour windows) is a **heuristic**: it floors the first entry to the hour, opens a new block after a 5-hour gap, and takes the token limit from a user-supplied value or the past maximum. It only sees local usage on this machine, not claude.ai chat or other devices, so it can diverge from the real server-side window.
- **Fit:** a useful reference for dedup rules, but it inherits the transcript format's instability and adds a dependency. Do not use it as the factory's source.

### 7. `/usage` command and the OAuth usage endpoint

Primary sources: [Manage costs effectively](https://code.claude.com/docs/en/costs), TypeScript SDK reference (`SDKUsageReport`).

- Interactive `/usage` shows session token totals, plan usage bars, and an attribution breakdown (approximate, from local history). When the usage endpoint is rate limited it falls back to bars cached within the last 60 minutes.
- The SDK reference documents an experimental `SDKUsageReport` (`usage_report` on the assistant message that delivers a `/usage` result). Its `rate_limits.limits[]` holds `kind`, `group`, `percent`, `resets_at` and `severity`, plus `extra_usage`. It is `null` when the OAuth token lacks the `user:profile` scope. The docs mark it "experimental, and its shape may change."
- **[observed]** `claude -p "/usage" --output-format stream-json` on v2.1.300 did **not** run the local command: the text went to the model as a prompt (cost about $0.12, no `usage_report`). **[unverified]** whether `/usage` produces `usage_report` in SDK streaming-input mode. If it does, it would be the cleanest pre-run check. Prototype it before relying on it.
- The HTTP endpoint behind `/usage` is undocumented, so it is not a supported interface.

### 8. Response headers

Claude Code does not expose API response headers to callers. The `rate_limit_event` fields appear to be derived from the API's unified rate-limit response headers. **[unverified]** That mapping has no public documentation for subscription (OAuth) traffic, so a factory should not proxy or parse headers itself.

## Implications for the factory

1. **Run metrics:** persist `modelUsage` (all four token types per model, plus `costUSD` marked as an estimate), `num_turns`, `duration_ms` and `duration_api_ms` from each run's final result. Key the record on `session_id` and handle resume semantics: store the delta against the previous total, or mark the figure as cumulative. Keep running per-step input and cache sums as a crash fallback.
2. **Window tracking:** on every `rate_limit_event`, store `{status, rateLimitType, resetsAt, unifiedWindows?, observedAt}` as the latest **usage-window snapshot**. The scheduler's pre-run check reads this snapshot. It stops scheduling on `status: rejected` or `allowed_warning` (or when utilization passes a budget), and treats the snapshot as stale once `resetsAt` passes or after N minutes. A cold start has no snapshot, so allow one run with a low concurrency cap, or ask the operator.
3. **Abstract the source** behind a usage-window port, so the factory can later swap in a documented feed (`SDKUsageReport` if `/usage` works over the SDK, or a status-line relay) without touching the scheduler.
4. **OpenTelemetry** stays optional for the "metrics export" question. It adds nothing for windows.
5. **Probe cost:** **[observed]** even a one-word `claude -p` haiku run created about 40k cache tokens (system prompt and tools), which counts against the window. Do not "ping" the window with throwaway runs.

## Sources

- Claude Code docs, status line: https://code.claude.com/docs/en/statusline
- Claude Code docs, OpenTelemetry monitoring: https://code.claude.com/docs/en/monitoring-usage
- Claude Code docs, costs and `/usage`: https://code.claude.com/docs/en/costs
- Claude Code docs, headless / `claude -p`: https://code.claude.com/docs/en/headless
- Claude Code docs, sessions and transcript storage: https://code.claude.com/docs/en/sessions
- Agent SDK docs, cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Agent SDK TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK type declarations v0.3.300: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.300/sdk.d.ts
- ccusage source v20.0.33: https://github.com/ccusage/ccusage
- Local probes: Claude Code 2.1.300 on Windows 10, Pro subscription; `claude -p … --output-format stream-json --verbose`; transcript field names under `~/.claude/projects`.
