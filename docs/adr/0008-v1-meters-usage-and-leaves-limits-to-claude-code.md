---
status: accepted
---

# v1 meters usage and leaves usage limits to Claude Code

v1 records every run's token usage and shows it in the TUI, but it doesn't limit work by tokens, cost, time or usage window. It has no budgets, no holds before a run starts, no weekly pacing and no API overflow. When a run hits a subscription usage limit, Claude Code's own retry watchdog waits it out instead of the factory stopping and requeueing the run. We chose this because the operator is on Max and v1's volume won't strain the window soon, while budgets and window-aware scheduling were the costliest part of the scheduler to build and test. Metering comes first because limiting later needs exactly the data it records. Decided in [How are metrics modelled and the usage window respected?](https://github.com/kevinverreault/agents-factory/issues/16).

## Decisions

- **Metering is per run and model.** Each run stores one usage record per model: input, output, cache-read and cache-write tokens, plus the client's `costUSD` estimate. The record holds the **delta** against the last total seen for that session, because a resumed run reports the whole session's total. Per-minute samples come from per-step usage, deduplicated by `message.id`. At run end, a correction sample brings them into line with `result.modelUsage`. Every view (task, task tree, group, stage, Ralph ticket, model) is a query over runs, not a stored counter. Outcome metrics come from records that already exist: run outcomes, attention requests, task transitions and linked PRs.
- **The only scheduling gate is the slot cap.** One global cap on active AFK runs (default 2) decides whether a queued task may start. The order is operator priority (normal or urgent), then work that continues something in flight, then first in, first out.
- **AFK runs set `CLAUDE_CODE_RETRY_WATCHDOG=1`, with the usage-limit wait capped at about 6 hours.** A 5-hour limit is waited out inside the run. The run stays active, keeps its slot, and shows "waiting for window" (detected from `system/api_retry` events with `error: 'rate_limit'`). A weekly limit resets beyond the cap, so the request fails and the run ends `failed` with an attention request naming the reset time. `autoContinueAtUsageLimit` can't do this job, because it is interactive-only. HITL runs don't set the watchdog: the conversation shows the limit, and the operator decides.
- **The runaway guard is the SDK's `maxTurns`.** There's a global default, and a stage can set `max_turns`. Hitting it ends the run `failed` with the normal failure attention request.
- **Usage snapshots are for display only.** Snapshots stay stored per `rateLimitType` and expire at `resetsAt` (ADR 0003). They feed the TUI's usage strip, and nothing gates on them.
- **Upgrade seams, built now at no extra cost:** a single admission check in the scheduler (it checks only slots in v1), the usage-snapshot port, and usage records keyed by stage. The preset schema has no `budget` key, so adding one later is additive.

## Supersedes

- ADR 0003's rule that the factory doesn't set `CLAUDE_CODE_RETRY_WATCHDOG`. That rule existed to protect a scheduler rule (stop every run when the window runs out) that v1 no longer has.
- The `stopped` run outcome (usage window ran out) and the `budget spent` outcome, along with stage `budget`, the Ralph loop's budget and `iteration_budget`, and the Extend action.

## Considered options

- **Budgets in API-equivalent dollars, enforced through `maxBudgetUsd`.** These normalise across models and are enforced natively. Deferred along with all budgets.
- **Budgets in tokens.** The SDK has no hard token cap (`taskBudget` is alpha and only advisory), so the factory would interrupt runs itself. Deferred.
- **A factory-owned window: hold starts above a threshold, pace the weekly window, and stop and requeue on exhaustion.** This leaves headroom for the operator's own chat, but it is the most logic to build and test. Rejected for v1.

## Consequences

- The factory can drain the shared window before the operator's own chat gets any. The usage strip makes this visible, and lowering the slot cap is the lever.
- A run waiting out a 5-hour limit holds a slot and keeps the machine awake (ADR 0003) for up to the cap.
- The watchdog also retries 529 overloads indefinitely. The wait cap bounds that too, and the walking skeleton should confirm how `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` (undocumented) and `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` behave.
