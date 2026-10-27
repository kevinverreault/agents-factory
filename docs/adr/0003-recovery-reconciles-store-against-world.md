---
status: accepted (watchdog rule and `stopped` outcome superseded by ADR 0008)
---

# Recovery reconciles the store against the world

When the daemon dies ungracefully (crash, kill, power loss), its next start reconciles the store with what is actually running, using the same rules as a graceful stop (ADR 0002): active AFK runs are requeued, and suspended and live HITL runs are parked. Before that, it replays any operator verb that was left half-done, and it sweeps up processes and containers the old daemon left behind. We chose one set of reconciliation rules for both kinds of stop because the SDK can't reattach to a running query in either case. The only real difference after a crash is the debris: half-done verbs, orphaned processes, a stale turn still running in an L2 container. Sleep is treated as a pause the CLI mostly recovers from on its own, plus wall-clock deadlines that fire on wake. Decided in [How does the factory recover from a daemon crash or machine sleep?](https://github.com/kevinverreault/agents-factory/issues/20).

## Decisions

- **A crash reconciles like a graceful stop.** The daemon writes a clean-shutdown marker only on a graceful stop. At start, every run the store still shows as active or suspended gets the ADR 0002 treatment. The marker only decides whether a recovery report is shown and whether the start-up sweep runs.
- **A new run outcome, `interrupted`.** An active run ended by a daemon stop or crash ends `interrupted`, with a graceful or unclean flag. It doesn't reuse `stopped`, which means the usage window ran out. Parked runs keep `parked`.
- **Crash-loop guard.** If a task's run was active at two unclean starts in a row, it isn't requeued. Its run ends `failed` and raises a failure **attention request**. The count is per task, and any run that ends normally resets it.
- **Multi-step verbs are journaled as intents.** Any operator verb with side effects outside the store (handoff, takeover, cancel cascade, spawning a child, advancing a stage) first commits an intent row, then performs idempotent steps. Recovery replays unfinished intents *before* reconciling runs. For a **handoff**:
  - **Confirmed sheet:** recovery finishes the handoff (commit, push at L2, end the HITL run, queue the AFK run).
  - **Unconfirmed sheet:** the HITL run is parked and the brief draft is saved on the task, so reopening shows the sheet pre-filled again.
- **The resumed agent gets a recovery note.** The next run after an `interrupted` one resumes the session with a fixed opening note: "The factory restarted mid-turn. Your last turn may be incomplete. Check `git status` and re-verify before continuing." The worktree is left exactly as found and never reset. The transcript needs no repair: since Claude Code 2.1.281, resume inserts a synthetic "interrupted" `tool_result` for a tool call whose result was never recorded.
- **The factory spawns every CLI itself, and sweeps orphans after every run.** Every run passes `spawnClaudeCodeProcess`, on the host too, so the daemon knows the CLI's PID. It records that PID and its creation time on the run.
  - **Sweep (the guarantee):** at every run end, normal or not, and at daemon start, the daemon kills every descendant of that PID. On Windows it walks `Win32_Process` by `ParentProcessId`, keeping only processes newer than their parent so a reused PID is never matched. On Mac it kills the run's process group. This runs even when nothing crashed, because MCP servers are orphaned after normal session ends too ([SDK #219](https://github.com/anthropics/claude-agent-sdk-typescript/issues/219)).
  - **Job object (a bonus, unproven):** a long-lived PowerShell helper, a non-detached child of the daemon, holds one kill-on-close job that allows no breakaway. Each CLI is assigned to it right after spawn, so a daemon crash takes the whole tree down. The walking skeleton must prove that it works with nested jobs, and it is dropped if it doesn't.
- **An L2 container is restarted before its run is requeued.** Killing `docker exec` doesn't kill the process inside the container ([moby #9098](https://github.com/moby/moby/issues/9098)). On stdin EOF, `claude` finishes its turn with every hook and permission call failing as "declined". So recovery runs `docker restart` on the task's container before requeueing. That kills the stale turn and any orphans, and keeps the clone with its unpushed commits. A graceful stop does the same after its interrupt.
- **Recovery never deletes containers or worktrees.** It matches containers (by factory label) and worktrees (under the factory's worktree directory) against the store.
  - **Belongs to a live task:** kept, and reused by the requeued run.
  - **Belongs to a Done or Cancelled task, or to no task:** a container is *stopped* but not removed, since it may hold unpushed L2 commits. A worktree is left alone. Both are listed in the recovery report, with delete and keep actions for the operator.
- **One recovery report in the attention queue.** After an unclean start, or a wake that disrupted runs, a single dismissable *Factory recovered* entry appears in the **attention queue**. It lists runs requeued or parked, intents replayed, orphans killed, and containers and worktrees found. Each affected run also shows its outcome in the task's history.
- **No supervisor in v1.** After a crash, an attached TUI restarts the daemon through its usual auto-start. If no TUI is open, queued work waits until the operator opens one. Revisit this together with start-at-logon.
- **Timers are persisted wall-clock deadlines.** The 30-minute idle park and the attention-request timeout are absolute deadlines in SQLite, not in-memory timers. On start or wake, every overdue deadline fires at once, so a long sleep parks idle HITL runs and times out suspended AFK runs as soon as the machine wakes.
- **The machine is kept awake while AFK runs are active.** While at least one AFK run is active, the daemon holds an idle-sleep block. On Windows that is a PowerShell helper calling `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)`, and on Mac it is `caffeinate -i -w <daemon pid>`. The display may still sleep, and lid close or a user-chosen sleep still wins. The block is on by default, with a setting to turn it off. Suspended runs, queued tasks and HITL runs don't hold it.
- **Wake handling is light.** A wake is detected by an interval-gap check (for example a 5 s tick, where a gap over 60 s counts as a wake). Monotonic clocks can't be used, because on both Windows (QPC) and Mac (`mach_continuous_time`) they count time asleep. On wake, the daemon fires overdue deadlines and refreshes the usage-window view. It leaves active runs alone: the CLI's stream watchdogs (180–300 s) and its 10 retries recover a dead connection. A run that fails anyway raises the normal failure attention request, with a "failed shortly after wake" hint. The factory doesn't set `CLAUDE_CODE_RETRY_WATCHDOG`, because waiting out a 429 until reset would fight the scheduler's rule to stop runs when the **usage window** runs out.
- **The usage-window snapshot is persisted, and expires at `resetsAt`.** The scheduler stores the latest `rate_limit_event` per `rateLimitType` in SQLite, with its `resetsAt` and the time it was received, so a restart doesn't forget a `rejected` window. On start or wake, a snapshot whose `resetsAt` has passed counts as reset. A snapshot that hasn't reached its reset stays valid, accepting that the operator's own chat may have spent more of the window since. The next run's event corrects it.

## Considered options

- **Park everything after a crash.** Safer, but AFK work would stall until the operator looks, which defeats the point of AFK.
- **One attention request per affected run.** Rejected as noise. One recovery report summarizes it all.
- **Reap orphans only after a crash, using PID diffs.** Rejected: orphans also appear after normal run ends, and PID diffs break with parallel runs and PID reuse.
- **`pkill` inside the container, or waiting for the stale turn to end.** The first misses the orphans, and the second is slow and unbounded.
- **A watchdog process that respawns the daemon.** Deferred along with start-at-logon.

## Consequences

- The store needs an intents table, a per-task crash counter, deadline columns and persisted usage snapshots. The **parked run** and handoff flows must be written as idempotent steps.
- The walking skeleton (ADR 0001) gains two checks: the job-object helper with nested jobs, and that the keep-awake helper's block holds while the helper lives.
- Removing worktrees and containers after a task is Done or Cancelled is routine cleanup, not recovery, and is still undecided.
