# Windows walking skeleton: findings

The first build slice ([#24](https://github.com/kevinverreault/agents-factory/issues/24), build order step 1 of [#23](https://github.com/kevinverreault/agents-factory/issues/23)) proves the risky platform assumptions on the **operator**'s Windows 10 machine before any production slice relies on them. Each proof is a Seam 3 test, an adapter contract test against the real thing (see Testing Decisions in #23). The tag is the file name: contract tests are named `*.contract.test.ts(x)`, and the default `npm test` excludes them. They run with:

```bash
npm run test:contract
```

They spend a little subscription usage on haiku (the SDK and plugin proofs), open and close a console window, and briefly hold an idle-sleep block. Recorded on 2026-10-28 with `@anthropic-ai/claude-agent-sdk` **0.3.312** (bundled `claude.exe` **2.1.312**), Node 24.21, Windows 10 22H2 (19045), Windows Terminal 1.24, `gh` 2.102.

| Assumption | Result | Proof |
|---|---|---|
| SDK streaming input, tool calls, `interrupt()` | Holds. No `claude -p` fallback needed | `src/executor/agent-sdk.contract.test.ts` |
| Detached daemon survives its terminal window closing | Holds, for a console window and for Windows Terminal | `src/daemon/spawn-detached.contract.test.ts` |
| Kill-on-close job helper with nested jobs | Holds. Keep the helper | `src/os/job-object.contract.test.ts` |
| Keep-awake helper holds an idle-sleep block | Holds | `src/os/windows-processes.contract.test.ts` |
| Descendant sweep: a run's tree, by its job and by parent PID, never a reused PID (#62) | Holds | `src/os/windows-processes.contract.test.ts` |
| Factory plugin loads, `/factory:<skill> args`, cross-skill calls | Holds. No `.claude/skills/` fallback needed | `src/skills/plugin.contract.test.ts` |
| `gh` re-reads a refreshed `hosts.yml` | Holds | `src/github/gh-config.contract.test.ts` |
| Retry watchdog wait caps | Behave as #23 expects, with the settings below | `src/executor/retry-watchdog.contract.test.ts` |
| L2 sandbox: bundle round trip, restart, no credentials (#64) | Holds on Docker Desktop 27 (WSL 2 engine) | `src/sandbox/docker.contract.test.ts` |
| A real L2 run in its container: commits on the subscription token, guards checked there, commit brought out, questions reach the operator despite `bypassPermissions` (#64), through the egress proxy with nothing denied (#65) | Holds. Needs `agents-factory setup token` | `src/executor/l2-run.contract.test.ts` |
| L2 egress: default-deny through a proxy of the task's own (#65) | Holds on Docker Desktop 27 | `src/sandbox/docker.contract.test.ts` |
| Ink tells `ctrl+h` from Backspace | No. Windows Terminal sends `08` for ctrl+h (and for ctrl+Backspace), `7f` for Backspace, and no kitty sequences. `/handoff` is the primary path | `src/tui/keys.contract.test.tsx`, `npm run probe:keys` |

## Agent SDK on Windows (SDK #359, #444)

- One **run** took streamed user messages across turns, ran an approved Bash call, and kept its context into the next turn.
- `interrupt()` during a running `sleep 120` ended the turn within 15 s (asserted), with no crash. The same run then answered the next streamed message.
- An in-process MCP tool from `createSdkMcpServer` was called from a streamed run and gated through `canUseTool`. Neither "Stream closed" (#359) nor the interrupt segfault (#444) reproduced.
- With no `pathToClaudeCodeExecutable`, the command the SDK hands to `spawnClaudeCodeProcess` is its bundled `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`, never the operator's installed `claude`. The daemon can spawn it itself and record the PID.

For the autonomy gate (later tickets):

- **Read-only Bash never reaches `canUseTool`**, even under `permissionMode: 'default'` with no allow rules. `cat file` and `sleep 120` ran without asking, and only `cp` was asked about (all three asserted). L1 permission requests will only ever see calls Claude Code itself considers non-read-only.
- **A bare `allowedTools` entry shadows `canUseTool`** for that tool. The SDK printed a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning when an early version of the MCP test did this (not kept as a test). Gate factory MCP tools through `canUseTool` or a PreToolUse hook, not `allowedTools`, wherever the factory needs to see the call.
- The SDK throws from the message iterator once the CLI returns an error result, rather than only yielding a `result` with `is_error`. The executor adapter must catch it and turn it into the run's failure.

## Detached daemon start (ADR 0002)

`spawnDetached` (`src/daemon/spawn-detached.ts`) starts the daemon with `detached: true`, `windowsHide: true`, `stdio: 'ignore'` and `unref()`.

- **Console window: holds.** A TUI stand-in in a classic console window auto-starts the daemon stand-in, then the window is closed with `WM_CLOSE` (what its close button sends). The TUI dies, and the daemon lives on. With `detached: false` the same test fails, because the daemon dies with the window (checked by hand once, not kept as a test).
- **Windows Terminal: holds.** The operator checked this by hand on 2026-10-29, because a command started from an agent session can't drive a Windows Terminal window: the session's processes don't see the desktop's windows, and commands passed to `wt.exe` never ran. They ran `npm run probe:terminal-close` in Windows Terminal 1.24 and closed that window with its close button. `npm run test:contract -- src/daemon` then passed both tests: the TUI stand-in was gone, and the daemon stand-in was still alive.

  To re-check, run the same two commands. The Windows Terminal test is skipped unless the probe has just been run, and it removes the probe's record and the daemon stand-in when it finishes.

## Kill-on-close job helper (ADR 0003)

`openKillOnCloseJobs()` (`src/os/job-object.ts`) starts a non-detached PowerShell helper. It holds one job per run (#62), each with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway, and assigns each PID it is sent to the job named with it. The test's tree is daemon → CLI → tools. The tools take the two routes out of libuv's jobs: one started through a shell (`cmd.exe`), one started `detached`. The daemon then "crashes" (`taskkill /F`, no tree kill).

- **With the job, everything dies:** the helper (killed by the daemon's libuv job), the CLI, and both tools. Assigning a process that is already in libuv's job (and in the test runner's job) works, so nested jobs are fine on Windows 10.
- **Without the job, both tools are orphaned.** The CLI itself dies, and so would any direct child of a libuv process, because each libuv parent kills its own non-detached children. Anything started through a shell, or `detached`, survives. This matches ADR 0002's "their children break away silently".
- Not covered: the stand-ins are Node, not the Bun-built `claude.exe`. Bun spawns through libuv too, so the routes out are the same, but it isn't proven. The descendant sweep stays the guarantee, as ADR 0003 says.

## Descendant sweep (ADR 0003, #62)

`osProcesses()` (`src/os/processes.ts`) is the OS process port's Windows adapter, and shares its contract (`src/os/processes-contract.ts`) with the fake. The executor hands each CLI to `adopt` right after spawn, which assigns it to its run's job. At the run's end, `sweep` closes that job, then walks `Win32_Process` by `ParentProcessId` from the CLI's PID, keeping only processes newer than their parent.

- **The job is what reaches a tool started through a shell once the CLI is gone.** When the CLI exits, libuv kills its direct children, the shell among them, and the tool the shell started is left with a dead parent PID that no walk can follow. The contract test without the job's half failed on exactly this. Runs usually end that way: `runCompleted` arrives after the CLI exits.
- **The walk alone finds the tree of a CLI that still runs,** as at the start after a crash, when this daemon holds no job for the dead daemon's runs.
- **A reused PID is never matched.** If another process holds the CLI's PID now, only children started before it count as the CLI's. The test records the CLI as created a minute earlier than it was, and the sweep kills nothing.

## Keep-awake helper (ADR 0003)

`holdAwake()` (`src/os/keep-awake.ts`) starts a PowerShell helper that calls `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and holds it until its stdin closes. The block is observed through `CallNtPowerInformation(SystemExecutionState)`, which needs no elevation. `powercfg /requests` needs an elevated prompt, so it can't be used in tests or by the daemon.

- The block is set while the helper lives. It is released when the daemon stops the helper, and also when the helper is killed.
- The test refuses to run if another process already holds `ES_SYSTEM_REQUIRED`, because the readout is system-wide. Since #62 it is part of the OS process contract, which the daemon's keep-awake uses. When #62 landed (2026-11-07), another process on the operator's machine held the block, so the keep-awake checks weren't re-run then. The helper itself didn't change.

## Factory skill set as a local plugin (ADR 0005)

`buildPlugin()` (`src/skills/plugin.ts`) writes `.claude-plugin/plugin.json` (`name: factory`) and `skills/<name>/SKILL.md`. The run uses the AFK settings from ADR 0005 (`settingSources: ['project']`, auto memory off, plus the plugin), in an empty project.

- The plugin loads (`system/init` lists `factory` with no `plugin_errors`, and `factory:skeleton-echo` among the slash commands).
- `/factory:skeleton-echo alpha beta` as the prompt runs the skill with `$ARGUMENTS` = `alpha beta`.
- A skill that names another skill bare ("invoke the `skeleton-callee` skill") reaches it. In the runs recorded, the model called the Skill tool with `factory:skeleton-callee` (the test accepts the bare name too). Upstream cross-skill references such as wayfinder → `research` should resolve the same way. **The `.claude/skills/` + `.git/info/exclude` fallback isn't needed.**

## `gh` and a refreshed `hosts.yml` (ADR 0004)

`gh` reads `hosts.yml` from `GH_CONFIG_DIR` on every call. A token rewritten between two calls is what the next `gh auth token` prints. A `gh api` call made with a revoked token in the file fails with `401 Bad credentials`, rather than falling back to the operator's own login, because `GH_TOKEN` and `GITHUB_TOKEN` are unset. Refreshing the read-only bot token in place mid-run should therefore work. A successful API call with a refreshed *valid* token wasn't exercised, because that needs a real bot token; the first GitHub-writer slice should cover it.

## Retry watchdog and its wait caps (ADR 0008)

The CLI's code (2.1.312) shows how the variables behave:

- `CLAUDE_CODE_RETRY_WATCHDOG=1` turns the watchdog on.
- `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` is a **total budget for usage-limit waits** in one request. On a 429 with `anthropic-ratelimit-unified-status: rejected`, the CLI sleeps until `anthropic-ratelimit-unified-reset`. If the reset is further away than the budget left, **it fails at once** (`usage_limit_wait_too_long`) instead of waiting part of the way. The one exception is when the response says overage is allowed.
- `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` is a total budget for all watchdog waits in a request. It ends otherwise endless 529 (overloaded) retries with `capacity_wait_exhausted`.
- A single sleep is hard-capped at 6 hours, whatever the variables say.
- Two more variables exist, also undocumented: `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE` (`capacity` limits the watchdog to 429/529) and `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS`.

The contract test drives the bundled CLI against a local fake Messages API, using an API key and an empty config dir. It saw:

- **Reset within the cap:** one `system/api_retry` event with `error: 'rate_limit'` and `retry_delay_ms` equal to the time until the reset, then success in the same run.
- **Reset beyond the cap** (3 days away, with a 60 s cap): the run failed with the 429 straight away, with no `api_retry` event (no sleep at all).
- **Endless 529s** with `MAX_WAIT_MS=20000`: the run gave up after about 20 s.
- **No watchdog** (HITL runs): an ordinary retry (`max_retries: 10`, sub-second backoff) that ignores the reset time.

**Settings for AFK runs:** `CLAUDE_CODE_RETRY_WATCHDOG=1`, with both `..._MAX_USAGE_LIMIT_WAIT_MS` and `..._MAX_WAIT_MS` at `21600000` (6 h). A 5-hour limit is then waited out inside the run. A weekly limit whose reset is more than 6 h away fails the run straight away, rather than after 6 hours. **This doesn't fully match #23 story 116** ("a weekly usage limit to fail the run"): the cap only looks at how far away the reset is, so a weekly limit that resets within 6 h is waited out like a 5-hour one. ADR 0008 assumes a weekly reset is always beyond the cap. If that edge matters, the factory has to tell the two apart itself from the `rate_limit_event` `rateLimitType`. "Waiting for window" can show the reset time, because `retry_delay_ms` on the `api_retry` event is the wait. The failure itself carries only the API's message, so the attention request's reset time should come from the last `rate_limit_event` snapshot.

Not proven: a real subscription usage limit, and the 6 h values themselves. The code path doesn't check the auth type, but the fake ran with an API key, and the tests use 60 s and 20 s caps, which go through the same arithmetic.

## `ctrl+h` and Backspace in Ink

Ink's half (Ink 8.0.0):

- With legacy key bytes, Ink's `useInput` reports both BS (`0x08`, what ctrl+h sends) and DEL (`0x7f`) as `key.backspace` with `ctrl: false`. **`useInput` can't tell them apart.**
- Kitty keyboard protocol sequences are parsed whenever they arrive: ctrl+h (`ESC [104;5u`) reads as `input: 'h', ctrl: true`, distinct from Backspace (`ESC [127u`). A terminal only sends them once asked, which is what `render(…, { kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] } })` does.
- The raw sequence still differs below `useInput`, but Ink exposes it only through its untyped internal event emitter.

Terminal half, recorded by the operator on 2026-10-29 in Windows Terminal 1.24 with `npm run probe:keys` (and again with `-- --kitty`):

| Key | Raw bytes | `useInput` |
|---|---|---|
| Backspace | `7f` | `backspace: true, ctrl: false` |
| ctrl+h | `08` | `backspace: true, ctrl: false` |
| ctrl+Backspace | `08` | `backspace: true, ctrl: false` |

The `--kitty` run gave the same bytes. Ink's `auto` mode didn't switch the terminal to kitty sequences, so the kitty protocol isn't available here.

**Verdict for the handoff ticket: `/handoff` is the primary path, and `ctrl+h` is best effort at most.**

- ctrl+h can be told apart from Backspace only by its raw byte (`08` vs `7f`), through a key hook on Ink's internal event emitter.
- ctrl+Backspace also sends `08`. So a `ctrl+h` binding would also fire on ctrl+Backspace, which many people press to delete a word. A handoff that interrupts the agent shouldn't be one slip away from a text-editing key.
- To offer `ctrl+h` anyway, the handoff sheet already gives the safety net: opening it is never a commitment, and `esc` backs out (#23 story 56).

To re-check after a Windows Terminal or Ink upgrade, run `npm run probe:keys` and `npm run probe:keys -- --kitty`, then press the same three keys.

## L2 sandbox on Docker (ADR 0007, ADR 0011)

`dockerSandbox()` (`src/sandbox/docker.ts`) runs each L2 task in a container of its own, from an image it builds on first use: `node:24-bookworm-slim` with git, `gh`, curl, and the Linux CLI of the pinned SDK (`@anthropic-ai/claude-agent-sdk-linux-x64`). The shared contract (`src/sandbox/sandbox-contract.ts`) runs against the fake and against Docker Desktop 27.0.3 on Windows 10, recorded on 2026-11-07:

- Commits made in the container reach the host task branch through a `git bundle`, as a fast-forward, and the host branch's new commits reach the container at the next prepare. A branch changed on both sides is refused either way.
- `docker restart` kills a turn still running in the container (a `sleep` that would have written a file never did), and the `docker exec` that started it ends. The clone keeps commits not yet brought out.
- The container runs as uid 10001 with no credential in its environment or home. Only the host clone's git directory is mounted, read-only, so the operator's working files stay out and a push to it fails. The skill set copied in can't be changed.
- A run's gitconfig and hooks, written on the host into the run directory the container mounts read-only, hold inside it: commits carry the factory's trailers, and pushes fail on the `pushInsteadOf` scheme. Docker Desktop's bind mounts keep the hooks executable.
- The sessions mount is the CLI's project directory for `/work`, shared with the host.
- `claude --version` in the container reports the version the pinned SDK bundles.

- Egress is default-deny (#65). The container shares an internal network with its task's egress proxy alone (`src/sandbox/egress-proxy.ts`, run by the image's Node). On that network no outside name resolves and no outside address routes: `curl --noproxy '*'` fails to the allowed host by name and to `1.1.1.1` by address. Through the proxy, HTTPS to the allowed host goes through, and HTTPS and plain HTTP to any other host get a 403. The container lists each denied host once, and the next prepare starts the list afresh with its new allowlist.

A real L2 run (`src/executor/l2-run.contract.test.ts`, on the token from `agents-factory setup token`) runs Claude Code in the container through the proxy on the built-in hosts alone, with nothing denied, recorded on 2026-11-07. Its CLI runs with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so its telemetry never shows among the denied hosts.

