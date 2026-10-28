---
status: accepted
---

# The factory registers the operator's own clones and keeps repo settings in its store

A **repository** is a GitHub repository the operator registers by pointing the factory at a clone they already have. The factory never clones a repo itself. Task worktrees hang off that clone's `.git`, and L2 containers clone from a read-only mount of it (ADR 0004), so the operator sees every **task branch** in their own `git log` without fetching from anywhere. A factory-owned clone would have kept the operator's hooks and config out of runs, but ADR 0007 already snapshots `.git/hooks` and `.git/config` and cleans the run environment, so it would have bought little isolation at the cost of a second copy the operator has to sync. Repo settings belong to the operator and live in the daemon's store, never in a committed file, matching ADR 0007's rule that a repo can't configure its own runs. Decided in [How does the factory register the repositories it works on?](https://github.com/kevinverreault/agents-factory/issues/21).

## Decisions

- **Adding a repo.** `factory repo add [path]`, or "Register this repo" on the launch card when the TUI starts in an unregistered clone. It requires a GitHub `origin`. A repo is keyed by `owner/name`, with one registration per GitHub repo and the clone's path stored beside it.
- **Settings, in the store only:** `owner/name`, path, `base_branch` (default: the remote's default branch), `default_preset` (fallback `main-flow`), and the cached results of the two checks below. v1 has no per-repo allow rules, egress hosts, autonomy default, model overrides or check command.
- **Repo presets are read from the commit a task branches from.** At launch the factory runs `git fetch origin`, reads `.agent-factory/presets/` from `origin/<base_branch>` with `git show`, and freezes the result with that SHA as its source. The operator's working tree is never read. A `default_preset` that no longer resolves falls back to `main-flow`, with a warning on the launch card.
- **Task branches** are `factory/<task-id>-<slug>`, cut from `origin/<base_branch>` after the launch fetch. Children's branches are `factory/<task-id>-<slug>--c<n>` (ADR 0009).
- **Worktrees live under one global root,** default `~/.agent-factory/worktrees/<owner>-<name>/<task-id>/`, with children at `…/<task-id>--c<n>/`. The root is configurable globally, not per repo. Task ids are short (about 6 characters), and each worktree sets `core.longpaths=true`, so Windows path limits don't break deep `node_modules` trees.
- **Two checks, cached on the repo.** They run at `repo add`, at every launch, and on "Re-check". Nothing polls.
  - **The factory identity's App is installed on the repo** (ADR 0004). A missing installation is a warning at `repo add` and on the repo row. The launch card blocks only when the frozen preset has a stage that writes. The fix opens the App's installation settings in the browser and re-checks when the operator returns.
  - **The skill set's per-repo setup is done** (ADR 0005): `docs/agents/issue-tracker.md` and an `## Agent skills` block in `AGENTS.md` or `CLAUDE.md` both exist on `origin/<base_branch>`. A missing setup is a warning, never a block. The fix, "Set up now", launches the built-in one-stage HITL preset `setup`, which runs `/factory:setup-matt-pocock-skills` on its own task branch. The skill is interactive and has `disable-model-invocation`, so it has to run HITL. Its root goes to review, and the operator pushes and merges it like any task.
- **Choosing the repo at launch.** The launch card and quick launch default to the registered repo containing the TUI's working directory, then to the repo last used. A task's repo is fixed at launch, and its children inherit it.
- **A clone that moves.** At start-up and before every run, the daemon checks that the stored path still holds the same `owner/name`. If it doesn't, the repo is **missing**: its runs can't start, and one attention request is raised for the repo, not one per run. `factory repo move <new-path>` re-points the repo and runs `git worktree repair` on its task worktrees. `factory repo remove` refuses while the repo has unfinished tasks. Done and Cancelled tasks keep their history.

## Considered options

- **A factory-owned clone** under `~/.agent-factory/repos/`. Rejected: the operator would have to fetch from it to see L1 work, and ADR 0007 already provides the isolation it offered.
- **A committed `.agent-factory/config.yaml`** for repo settings. Rejected: there is one operator, so nothing needs sharing, and a repo shouldn't configure the factory that runs on it. Presets are the one exception, and they can't grant permissions.
- **A repo check command** gating Ralph iterations or `open-pr`. Left out of v1, which keeps ADR 0006's trust in `/implement`. Adding a `check` setting later is additive.

## Consequences

- Git refuses to check out a branch in two worktrees, so the operator can't check out a live task branch in their clone. Reviewing it means opening the task's worktree, or checking the branch out once the task is Done and its worktree is removed.
- Moving or deleting the clone suspends that repo's tasks until `factory repo move`.
- Removing worktrees, task branches and containers after a task ends is decided in ADR 0011.
