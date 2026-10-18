---
status: accepted
---

# The factory is the only GitHub writer for AFK work, as a GitHub App

AFK agents commit locally and never write to GitHub. The daemon writes for them from the host, through the preset's actions (`push`, `open-pr`, `close-ticket`, comments), under the **factory identity**, a GitHub App that is separate from the **operator**'s account. The Docker research assumed the opposite: a repo-scoped `GH_TOKEN` in the container, with the agent pushing and running `gh pr create`. That research also found that in a plain container the agent can read any token it is given. The operator is on GitHub Free, so rulesets can't protect `main` on their private repos, and a leaked Contents-write token could push anywhere. Keeping every write credential out of runs, and letting the factory choose the refspec, is the guard that works without rulesets. The App, rather than the operator's own account, keeps factory work separate on GitHub: the operator can be assigned to factory PRs and approve them, which they couldn't do as their author. Decided in [Which GitHub identity do AFK runs push and open PRs with?](https://github.com/kevinverreault/agents-factory/issues/19).

## Decisions

- **Commits leave runs, credentials never enter them.** At L2 the container clones from a read-only mount of the host repo. Its commits come out through `docker exec … git bundle`, are fetched into the host repo, and the daemon pushes the task branch with a refspec it chooses. Host-worktree runs commit in place and the same actions push.
- **The App's scope:** installed only on the operator's account and on the repos they select. Contents RW, Pull requests RW, Issues RW, Metadata R. No Workflows, Actions, Checks or Administration.
  - Workflows still trigger: pushes and PRs made with an installation token start `push` / `pull_request` runs, drafts included.
  - Without Workflows write the bot can't push `.github/workflows/` changes. The `push` action checks for them first and raises an **attention request** asking the operator to push the branch by hand.
- **One token per action.** The daemon mints an installation token for each action, narrowed through the token API's `repositories` and `permissions` parameters to the task's repo and to what that action needs. Nothing is cached.
- **No fallback to the operator's account.** The launch card checks the App's installation on the task's repo whenever the frozen preset has a stage that writes. A failure at action time becomes an attention request, and the action is retried after the operator fixes it. A silent fallback hides breakage, as the reference factory's bug-bash (BB-07) found.
- **AFK runs read GitHub with a read-only bot token.** It carries Issues, Pull requests and Metadata read, and sits in a per-run `GH_CONFIG_DIR` the daemon refreshes before the 1-hour expiry, so the skills' `gh issue view` keeps working. The operator's login is removed from the run environment (`GH_TOKEN` unset, git credential helper off, `GIT_TERMINAL_PROMPT=0`). On the host that prevents accidents, not malice, and containment remains L2's job.
- **HITL runs act as the operator,** through their own host `gh` login. Maps, specs and tickets written in HITL stages are theirs.
- **Secrets live in the OS credential store.** The App private key and the `claude setup-token` value are kept in Windows Credential Manager or the macOS Keychain, behind a secrets seam only the daemon calls. They never go into SQLite or an env file. `agents-factory setup github` creates the App through GitHub's manifest flow and writes the key straight into the store, so the `.pem` never touches disk.
- **Attribution.** AFK commits are authored and committed by `<slug>[bot]`, with `Factory-Task`, `Factory-Run` and `Model` trailers, and without Claude Code's `Co-Authored-By` trailer. HITL commits on the same task branch stay the operator's. `open-pr` opens the draft as the bot and assigns the operator, without a review request. The factory appends a footer listing the task id, each stage's model, and total tokens.

## Considered options

- **`GH_TOKEN` in the run, with the agent pushing** (the Docker research's recommendation). Rejected: the agent can read the token, and on Free private repos nothing stops it pushing to `main`.
- **The operator's own account** (their `gh` login or a fine-grained PAT). Rejected: factory PRs would look like the operator's own and couldn't be approved by them, and a PAT can't be minted per run.
- **No GitHub access for AFK runs**, with ticket bodies injected into prompts or served by an MCP tool. Rejected: the upstream skills read tickets with `gh`, and a read-only token keeps them unmodified.

## Consequences

- The walking skeleton (ADR 0001) gains a check that `gh` re-reads `hosts.yml` on every call, so a refreshed token takes effect mid-run.
- An agent can't push its own fixes for workflow files. Those branches always need a hand push from the operator.
- If the factory comes to watch CI on its PRs, the App gains Checks or Actions read, and the operator approves the change on the installation.
- Which repos the App is installed on is part of repository registration, which is still undecided.
