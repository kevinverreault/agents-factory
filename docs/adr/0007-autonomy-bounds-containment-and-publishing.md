---
status: accepted
---

# Autonomy levels bound where code runs and what the factory publishes, not what the agent writes

The glossary first defined an **autonomy level** by what the agent may do on GitHub: L1 local commits only, L2 push and open a draft PR. ADR 0004 then made the factory the only GitHub writer at every level, and ADR 0006 has `close-ticket` write at L1. So a level can no longer describe agent writes. Instead it bundles three things: where the run executes, how its tool calls are gated, and which factory actions may publish to GitHub. L1 means "no code leaves this machine". The task's code stays on the **operator**'s machine, though the factory may still update issues from its own templates. L2 runs in a container, and the factory may push the task branch and open a draft PR. Decided in [What does each autonomy level allow, and how is it enforced?](https://github.com/kevinverreault/agents-factory/issues/15).

## Decisions

- **The levels.**

  | | L1 | L2 |
  |---|---|---|
  | Where the run executes | the host task worktree, unsandboxed (native Windows has no Bash sandbox) | a Docker container clone (ADR 0004) |
  | Tool gate | `acceptEdits` plus a factory allow list; anything else asks the operator | `bypassPermissions` inside the container |
  | Factory GitHub writes | issue bookkeeping only (close and reopen tickets, templated comments) | plus `push` of the task branch and `open-pr` |

- **The L1 gate is factory rules, not `auto` mode.** Edits and file operations inside the worktree are auto-approved, along with:
  - a fixed allow list: read-only tools, WebFetch and WebSearch, the factory's MCP tools, read-only and local-commit git, package-manager scripts and test runners, and common read-only shell commands;
  - rules from `~/.agent-factory/permissions.yaml`;
  - the task's own rules.

  Anything else reaches `canUseTool` and raises a **permission request**, an **attention request** that suspends the run. The operator answers Allow once, Allow for this task (stored on the task), or Deny with a note.

- **No repo scope for permissions.** Allow rules and extra L2 egress hosts come from the built-in list, the user file and the task, never from the target repo. A repo you clone could otherwise grant its own runs permissions. A child task gets a frozen copy of its parent's task rules and egress hosts at spawn, and its level stays ≤ its parent's.

- **L2 asks no permissions.** Questions still reach the operator, because `AskUserQuestion` goes through `canUseTool` in every mode. Egress denials are logged on the run. When a run fails, its failure request lists the denied hosts, with "allow host for this task and retry".

- **Hard denies at every AFK level.** Deny rules plus a PreToolUse hook refuse the following, with a message ("the factory pushes for you"), and raise no attention request:
  - `git push`
  - remote changes
  - `git config --global` / `--system`, and repo config writes to `remote.*`, `url.*`, `credential.*` and `core.hooksPath`
  - switching branches, and `git worktree`
  - force operations, and rewriting history below the run's starting commit
  - `gh auth`

  The docs say Bash rules are not a security boundary (`git -C . push` slips past `Bash(git push *)`), so these refusals are best-effort.

- **Every AFK run is checked afterwards.** The factory checks git invariants after each run:
  - the task branch is still checked out;
  - the old tip is an ancestor of the new one;
  - the tree is clean;
  - no refs or remotes were added;
  - `.git/config` and `.git/hooks/` match their snapshot from before the run.

  A violation is a run or iteration failure.

- **A cleaned environment makes pushes fail in git itself.** Each AFK run gets:
  - `GIT_CONFIG_NOSYSTEM=1`, because Git for Windows's system config sets `credential.helper=manager`;
  - `GIT_CONFIG_GLOBAL` pointing at a per-run gitconfig, with the bot as author, no credential helper, and `pushInsteadOf` rewriting GitHub push URLs to an unreachable scheme, so fetch still works;
  - the read-only `GH_CONFIG_DIR` from ADR 0004;
  - `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` and `SSH_AUTH_SOCK` unset;
  - `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, and an ssh command that fails.

  `pushInsteadOf` is ignored when a remote has an explicit `pushurl`, which is why the handoff sheet and the check after each run look for one.

- **Research children push at L1, narrowly.** A wayfinder research child runs at L1, because it needs open web access, which L2's egress allowlist would block. Its `research/<name>` branch is the one exception to "no code leaves this machine". The `push` action pushes it only when its commits touch nothing but `docs/research/**`, and never the task branch. Anything else raises an attention request.

- **L1 tasks reach a PR through the operator.** An L1 root task in review offers **Push & open draft PR**. The operator's click authorizes the `push` and `open-pr` actions as the bot, without raising the level or starting a run.

- **The level changes only between runs.** Raising to L2 clones the task branch, local commits included, into the next run's container. Lowering to L1 fetches the last bundle and fast-forwards the host worktree. In a loop the change applies from the next iteration. Each stage's ceiling from the frozen preset still clamps it.

- **Levels carry no budgets.** Budgets belong to stages.

- **HITL runs are not guarded.** They act as the operator. Before a handoff, the sheet checks what the next AFK run needs: the task branch is checked out, the tree is clean, and no `pushurl` is set. Confirm stays blocked until those hold.

## Considered options

- **Keep the old definition** (L1 local commits, L2 push). Rejected: after ADR 0004 agents push at neither level, and L1 already closes tickets.
- **`auto` mode as the L1 gate.** It's available on every plan, Pro included. Rejected because:
  - a blocked action goes back to the model rather than to the operator, until 3 blocks in a row or 20 in total;
  - each check spends classifier tokens;
  - the same call can get a different answer from one run to the next.
- **Silent denial at L1.** Rejected: the agent would work around refusals the operator might have allowed. A permission request suspends the run at no slot cost, and `canUseTool` has no deadline.
- **Research children at L2, or findings only in a comment.** Rejected. L2's egress allowlist would block WebFetch. A comment loses the research branch that the map's context pointers link to.

## Consequences

- L1 on the host guards against accidents, not malice. A repo's test scripts run whatever they contain, and Bash can write outside the worktree. Containment is L2's job.
- Any preset with a loop, or with research children, needs the factory identity's App installed even at L1. ADR 0004's launch-card check already covers stages that write.
- On Mac, Claude Code's own Bash sandbox could tighten L1. Whether to use it belongs to Mac portability.
