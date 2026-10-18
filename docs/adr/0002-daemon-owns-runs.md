---
status: accepted
---

# A per-user daemon owns runs; the TUI is a client

Runs outlive the TUI. A per-user background daemon owns every **run**, the scheduler, the timers (attention-request timeouts, the 30-minute idle park) and the local store, and the TUI is only a client that attaches to it, so closing the TUI never touches a run. We chose this because AFK work exists to run while the **operator** isn't watching, the timers need a clock with no TUI open, and ADR 0001's path to option (b) already needs a long-lived endpoint for settings-file hooks and an out-of-process MCP binding. On Windows, closing a terminal window kills its process tree, so a TUI-only factory would stop a **Ralph loop** whenever the window closed. Decided in [Should runs outlive the TUI?](https://github.com/kevinverreault/agents-factory/issues/10).

## Decisions

- **One package, two entry points.** The daemon and the TUI ship together. The daemon isn't a separate install.
- **The store is one SQLite file, and only the daemon opens it.** It lives in the per-user app-data directory (`%LOCALAPPDATA%\agents-factory\` on Windows, `~/Library/Application Support/agents-factory/` on Mac), with WAL on. The TUI never reads it, so the schema and its migrations stay private to one module. Transcripts stay in Claude Code's own session files, and the store references them by session id.
- **`node:sqlite` behind a store seam.** It is Release Candidate (stability 1.2) on Node 24 LTS, needs no flag and adds no native dependency. better-sqlite3 v13 is the fallback adapter if the RC blocks progress. It is N-API now, with prebuilt binaries for win32-x64 and darwin-arm64. Both are synchronous and their APIs are close.
- **The link is a named pipe on Windows and a Unix socket on Mac, carrying newline-delimited JSON with a token handshake.** Node's `net` serves both with one API. There's no TCP port, so an L2 container can't reach the daemon even by accident. A default Windows pipe ACL grants read to Everyone, so the daemon writes a random token into the app-data directory, which only the operator can read, and every client must send it. The protocol is a small interface:
  - **Commands:** the operator's verbs (create task, send message, interrupt, hand off, take over, answer an attention request, cancel, and so on). Each returns ok or a refusal.
  - **A factory-state subscription:** a snapshot of the task list, the attention queue and the metrics summary, then patches.
  - **Per-run conversation subscriptions:** history replayed from the Claude session file, then the live factory run events. These are never SDK types (ADR 0001).

  Hook scripts and the future out-of-process MCP binding are small `agents-factory hook` / `agents-factory mcp` CLIs that relay over the same pipe.
- **The TUI auto-starts the daemon, and the daemon exits when idle.**
  - **Start:** if nothing answers on the pipe, the TUI spawns the daemon detached (`detached: true`, `windowsHide: true`, no inherited stdio, `unref()`) and retries. A CLI adds `agents-factory daemon status|stop`.
  - **Stay up:** while anything needs a clock: an active or suspended run, a queued task (even one waiting on the **usage window**), or an attached TUI. Otherwise it exits after about 10 idle minutes.
  - **No start-at-logon in v1.** Queued work resumes when the operator next opens the TUI. Start-at-logon can be added later: the HKCU Run key or Task Scheduler on Windows, a LaunchAgent on Mac.
- **One daemon per OS user, and any number of TUIs.** The pipe name is the single-instance lock: a second daemon fails to bind and exits. Every TUI gets the same events, the daemon serializes their commands, and there is no "driver" role.
- **Version skew is a handshake.** The daemon reports its protocol version when a client connects. On a mismatch, the TUI refuses to attach and offers *restart now* or *restart when idle*. In the second case the daemon starts no new runs and restarts once nothing is active.
- **A graceful stop ends its runs.** The SDK can't reattach to a running query from a new process; it can only resume a session by id. So a stop requeues active AFK runs, losing only their in-flight turn, and parks suspended and live HITL runs. "Factory restart" in earlier decisions means a daemon restart, never a TUI close.

## Considered options

- **A TUI-only process.** No IPC, no version skew, one process to debug. Rejected: closing the TUI would count as a factory restart, so unattended AFK work would depend on a terminal window staying open, and the timers and the hook endpoint would have no home while the TUI was closed.
- **Localhost HTTP with SSE or WebSocket.** Easier to poke at with curl. Rejected: it needs a port and an auth token anyway, and it's reachable from anything local, Docker Desktop's `host.docker.internal` included.
- **The TUI reading SQLite directly under WAL.** Rejected: it shares the schema across two processes and can show state the daemon hasn't finished committing.

## Consequences

- If the daemon dies, Windows kills the `claude` CLI child through libuv's kill-on-close job object. That job sets `SILENT_BREAKAWAY_OK`, though, so the CLI's own children (bash, MCP servers) are never part of it. The CLI is Bun, which spawns through libuv too, so its direct children probably die with it, but their children (bash → tool, npx → node) break away silently and are left orphaned. MCP servers are orphaned even after a *normal* session end ([SDK #219](https://github.com/anthropics/claude-agent-sdk-typescript/issues/219)). ADR 0003 covers how orphans are swept and what a daemon *crash* does, as opposed to a graceful stop.
- The walking skeleton (ADR 0001) should also check that a detached daemon survives closing the Windows Terminal window that spawned it. That comes from reading libuv's source and hasn't been tested.
