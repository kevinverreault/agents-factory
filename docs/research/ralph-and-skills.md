# How Ralph and Matt Pocock's skills expect to be driven

Research for the ticket "How do Ralph and Matt Pocock's skills expect to be driven?" (issue #5), part of the "Agent factory v1" map (issue #1). Researched 2026-10-14.

Labels used below:

- **[verified]**: read directly in the primary source cited.
- **[inferred]**: follows from the sources but no source says it outright.
- **[unverified]**: not confirmed. Check it before building on it.

## Sources

| Ref | Source | Version read |
| --- | --- | --- |
| R1 | aihero.dev, "Getting Started With Ralph", https://www.aihero.dev/getting-started-with-ralph | page `updatedAt` 2026-01-08 |
| R2 | aihero.dev, "11 Tips For AI Coding With Ralph Wiggum", https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum | updated 2026-01-08 |
| R3 | Geoffrey Huntley, "Ralph Wiggum as a software engineer", https://ghuntley.com/ralph/ | 2025-07-14 (where the technique comes from) |
| S1 | aihero.dev, skills landing page, https://www.aihero.dev/skills | fetched 2026-10-14 |
| S2 | `mattpocock/skills`, https://github.com/mattpocock/skills | `main` @ [`49dd158`](https://github.com/mattpocock/skills/commit/49dd158d1076134a641b33efb035946536778336) (2026-10-09). Latest tag `v1.3.1` @ `24fe0ef` (2026-10-04) |
| S3 | `mattpocock/skills/.agents/invocation.md` and `.agents/install-block.md` (the maintainers' own conventions) | same commit |
| S4 | `mattpocock/skills/docs/engineering/*.md` (the long-form doc behind each skill's aihero page) | same commit |
| X1 | `mattpocock/sandcastle`, https://github.com/mattpocock/sandcastle (Matt's TypeScript AFK runner; S4 calls it the deterministic alternative) | `main` @ `7a4e7f7` (2026-10-08) |
| C1 | Claude Code docs, "Run Claude Code programmatically", https://code.claude.com/docs/en/headless | fetched 2026-10-14 |
| C2 | Claude Code docs, "Skills", https://code.claude.com/docs/en/skills | fetched 2026-10-14 |
| V1 | `vercel-labs/skills` README (the `npx skills` CLI), https://github.com/vercel-labs/skills | fetched 2026-10-14 |
| L1 | Local install: `C:\Users\Kevin\.claude\skills` and `C:\Users\Kevin\.agents\skills` | read 2026-10-14 |

---

## 1. Ralph: the actual mechanics

### 1.1 Core idea (R3, R2)

- A shell loop starts a **fresh agent process with the same prompt** on every iteration. The original form is a `while` loop that pipes `PROMPT.md` into the agent CLI forever. [verified R3]
- **Each iteration does one item.** The agent picks the most important unfinished item itself, implements it, applies backpressure (tests, typecheck, static analysis), records progress and commits. [verified R2, R3]
- Context is never carried between iterations. Continuity comes only from **files on disk and git history**. [verified R1, R2]

### 1.2 The aihero.dev version (R1, R2)

**State files**

- `PRD.md` is the requirements doc and defines the end state. It is written beforehand in Claude Code's plan mode. The format is free: markdown, JSON or prose. [verified R1]
- R2 recommends JSON items, each with a category, a description, verification steps and a `passes` boolean. The agent flips `passes` to true when an item is done. You can change the target mid-run by resetting flags or adding items. [verified R2]
- `progress.txt` starts empty. Each iteration appends to it: the task done, decisions, blockers and files changed. It is deleted after the sprint. [verified R1, R2]

**Two scripts**

| Script | Mode | Invocation | Notes |
| --- | --- | --- | --- |
| `ralph-once.sh` | **HITL**: one supervised iteration | `claude --permission-mode acceptEdits "@PRD.md @progress.txt <prompt>"`, run on the host | You watch it, inspect the commit, tune the prompt, run it again |
| `afk-ralph.sh <N>` | **AFK**: a capped loop | `set -e`. Usage error if no `N`. `for i in 1..N`: `result=$(docker sandbox run claude --permission-mode acceptEdits -p "@PRD.md @progress.txt <prompt>")` | Runs inside a Docker sandbox. Stdout is captured so it can be checked for the completion sigil |

[verified R1]

**The prompt.** It is passed inline, and the state files are referenced as `@` mentions. In summary: [verified R1]

- Read the PRD and the progress file.
- Pick the highest-priority unfinished task. Ralph-once says "next incomplete" instead.
- Implement it, then run tests and typechecks.
- Update the PRD (mark the item done) and append to `progress.txt`.
- Commit.
- Do only one task.
- If the PRD is fully complete, print `<promise>COMPLETE</promise>`.

**How the next item is picked.** The agent chooses, reading the PRD and progress file. The script never chooses. R2 adds priorities: risky spikes, integration points and architecture first (do those HITL), then AFK once the foundation holds. [verified R1, R2]

**Stop conditions** [verified R1, R2]

1. The completion sigil `<promise>COMPLETE</promise>` appears in the captured output. The script prints how many iterations ran and exits 0.
2. The iteration cap `N` is reached. R2 suggests 5–10 iterations for small jobs and 30–50 for larger ones, and says a loop typically runs 30–45 minutes.
3. Any shell error ends the loop, because of `set -e`.

**Commits.** The agent commits from inside the iteration, one commit per task, and only after its feedback loops pass. Docker sandboxes inject git config so commits are attributed correctly. R2 suggests opening a PR per iteration instead of committing to main. [verified R1, R2]

**Sandbox and skills caveat.** `docker sandbox run claude` mounts only the current directory, keeps state per workspace, and keeps credentials in a Docker volume. R2 notes that **the global AGENTS.md and user-level skills are not loaded inside the sandbox**. Skills an AFK run needs must therefore be inside the repo or explicitly provided. [verified R2]

**Swapping the task source.** R1 and R2 both suggest using GitHub Issues, Linear or beads in place of the PRD file. [verified R1, R2]

### 1.3 The issue-driven Ralph Matt actually ships: Sandcastle (X1)

Sandcastle's `simple-loop` template is the Ralph loop rewritten over an issue tracker. It is the closest first-party reference for "one ready ticket per iteration, fresh context". [verified X1 `src/templates/simple-loop/*`, `src/InitService.ts`, `src/AgentProvider.ts`]

- **Driver.** `run({ agent: claudeCode(model), sandbox: docker(), promptFile, maxIterations, branchStrategy, hooks })`. Each iteration is a separate headless call, roughly `claude --print --verbose --output-format stream-json --model <m> [--dangerously-skip-permissions | --permission-mode X] [--effort E] -p -` with the prompt on stdin. It can also `--resume` or `--fork-session` a captured session. Sandcastle captures the session JSONL and reads token usage from it.
- **Prompt preprocessing.** Shell expressions in the prompt file run **inside the sandbox at the start of every iteration**. That way the agent always sees a fresh list of open issues and the last 10 commits tagged `RALPH`.
  - The GitHub list command is `gh issue list --state open --label Sandcastle --json …`.
  - The close command is `gh issue close <ID> --comment "Completed by Sandcastle"`.
- **Picking the next item.** The agent picks the highest-priority open issue that isn't blocked by another open issue. Priority runs: bug fixes, then tracer bullets, then polish, then refactors. The prompt says the pre-filtered list is the only source of truth: the agent must not run its own unfiltered query.
- **Per-iteration workflow.** Explore (including the parent PRD), plan, red-green TDD, run `npm run typecheck` and `npm run test`, then make **one commit**. The commit message starts with `RALPH:` and lists the task, decisions, files and blockers for the next iteration. Then close the issue.
  - If blocked, the agent comments on the issue and moves on without closing it.
  - When nothing actionable is left, it prints `<promise>COMPLETE</promise>`.
- **Stop conditions:**
  - `maxIterations` (default 1).
  - `completionSignal` (default `<promise>COMPLETE</promise>`).
  - `idleTimeoutSeconds` (default 600, reset by any output).
  - `completionTimeoutSeconds` (default 60), a grace period for processes still running after the signal.
- **Branching.** `branchStrategy` is one of `head` (the default for bind-mount sandboxes), `merge-to-head` (a temporary branch merged back to HEAD) or `branch` (a named branch). The result reports the commits, the branch and the per-iteration results.
- **Label mismatch.** Sandcastle filters on its own `Sandcastle` label, not on `ready-for-agent`. To drive Matt's skill outputs, the list command must filter on `ready-for-agent` instead. [inferred]

### 1.4 What this means for the factory's Ralph loop

- The loop must be **deterministic code in the factory**: pick the ticket, spawn a fresh headless Claude Code process, check the outcome. S4 says so directly: for truly AFK work, a deterministic loop (Sandcastle, a shell script, CI) is faster, cheaper and more reliable than letting an agent orchestrate. [verified S4 `implement-spec.md`]
- **The skills give no completion signal.** `/implement` ends at a commit and never closes or relabels the ticket (S4 `implement.md`). Two consequences: [verified S4] [inferred: the factory must do it]
  - The factory, or the iteration prompt, must close the ticket or move its label.
  - Otherwise the frontier never advances, because blocked tickets only become ready once their blockers are closed.
- **Exclude the parent spec when polling.** `/to-spec` puts `ready-for-agent` on the parent spec issue as well as on the tickets. A loop that polls `ready-for-agent` naively will try to build the whole spec in one run. S4 calls this the most-reported problem with that skill. The workaround is to exclude the spec issue, or to remove its label after `/to-tickets` runs. [verified S4 `to-spec.md`]
- There is no "implemented, awaiting verification" triage state, so an AFK runner can pick up finished tickets again. [verified S4 `triage.md`]

---

## 2. Matt Pocock's skills: how they are meant to be driven

### 2.1 Invocation model (S3, C1, C2)

- Every skill is either **user-invoked** (`disable-model-invocation: true`) or **model-invoked**. [verified S3]
  - A user-invoked skill can only be started by a human typing `/name`. No other skill can call it, and subagents never get it preloaded. [verified S3, C2]
  - Model-invoked skills are pulled in by other skills through explicit "call the Skill tool with X" steps. [verified S3]
- **Headless use works.** In `claude -p`, user-invoked skills and custom commands still work: put `/skill-name args` in the prompt string and Claude Code expands it before the run starts. [verified C1]
- **Arguments.** Arguments after the skill name are passed through as `$ARGUMENTS`. If the skill body has no `$ARGUMENTS` placeholder, Claude Code appends them as an `ARGUMENTS:` line. [verified C2]
- **Plugin installs are namespaced.** Plugin skills are invoked as `/mattpocock-skills:<name>`. The bare `/<name>` also works as long as nothing else claims that name. [verified C2] [inferred: the plugin name]
- **Factory implication: one stage, one process.** Each user-invoked stage (`/implement #42`, `/to-spec #1` …) has to be its own `claude -p "/<skill> <args>"` process (or an interactive session). An agent can't chain user-invoked stages itself. [inferred]

### 2.2 Preconditions

- **Run `/setup-matt-pocock-skills` once per repo.** It writes three files and adds an `## Agent skills` block to `CLAUDE.md` or `AGENTS.md`:
  - `docs/agents/issue-tracker.md`: GitHub, GitLab, local `.scratch/` markdown, or a custom tracker.
  - `docs/agents/triage-labels.md`.
  - `docs/agents/domain.md`.

  [verified S2]
- **Triage labels.** If `triage` is installed, the setup also creates any missing triage labels in the tracker. The canonical roles are `needs-triage`, `needs-info`, `ready-for-agent` (fully specified, ready for an AFK agent), `ready-for-human` and `wontfix`. `triage` also uses the category roles `bug` and `enhancement`. [verified S2]
- **Other skills depend on this setup.** Without these files, `to-spec`, `to-tickets`, `code-review` and the others tell the user to run setup. [verified S2]
- **This repo is already set up.** It matches the current templates: `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md` are byte-identical to the installed templates, and the five triage labels plus the `wayfinder:*` labels exist. [verified locally]
- **Domain docs:** `GLOSSARY.md` and `docs/adr/` at the repo root (renamed from `CONTEXT.md` in v1.3). [verified S1, S2]

### 2.3 The skills in the factory's default workflow preset

**Naming fix.** The map's preset names don't all match upstream:

- `to-ticket` is actually **`to-tickets`**.
- **There is no `create-mr` skill.** `/pr` is a model-invoked template for the PR body and never runs `gh pr create`.
- **No skill opens a PR.** Neither `/implement` nor `/implement-spec` (outside its own optional draft PR) does it.

The factory must own PR creation. It can use `/pr` to shape the body. [verified S2, S4 `implement.md`]

| Skill (invocation) | Inputs | Outputs | HITL / AFK | Hands off to |
| --- | --- | --- | --- | --- |
| **grill-with-docs** (user) | An idea in conversation; the repo; `GLOSSARY.md`, ADRs | Updated `GLOSSARY.md` and `docs/adr/*` written inline; a shared understanding in context | **HITL**: runs `grilling` (rounds of numbered questions, waiting for answers; the agent must never answer for the human) plus `domain-modeling` | `/to-spec` in the **same context window** (no clear or compact before `/to-tickets`), or `/wayfinder` if too big for one session |
| **wayfinder** (user) | A loose idea (chart mode), or a map issue number (work mode) | A `wayfinder:map` issue; child issues labelled `wayfinder:{research,prototype,grilling,task}` with native blocking edges; resolution comments; closed tickets; context pointers in the map's "Decisions so far"; `research/<name>` branches (pushed, no PR) | **Chart: HITL.** **Work:** depends on the ticket. Research is AFK (fired as parallel subagents, the only exception to "one ticket per session"). Prototype and grilling are HITL. Task is either. Claim = assign the ticket before any work | When the map clears: `/to-spec #<map>` (not straight to `/implement`) |
| **to-spec** (user) | The current conversation (or a map issue) plus the codebase | One spec issue (problem, solution, user stories, implementation and testing decisions, out of scope) labelled `ready-for-agent` | **Mostly AFK** (no interview), but one **HITL checkpoint**: confirm the proposed test seams with the user | `/to-tickets` |
| **to-tickets** (user) | A spec, plan or conversation; optionally an issue reference | One issue per tracer-bullet vertical slice, as **sub-issues of the source issue**, with **native blocking edges**, labelled `ready-for-agent`, published blockers first. The parent is never modified | **HITL**: quizzes the user on the breakdown and iterates until approved, then publishes | `/implement` per ticket (clear context between tickets), or `/implement-spec` for the whole graph |
| **implement** (user) | A ticket reference (fetched from the tracker; states its title) or a spec | Code plus tests, **committed to the current branch** (it creates no branch). Does not close the ticket, tick its criteria, act on review findings or open a PR | **Designed for AFK**, but it runs `tdd`, which must "confirm seams with the user" before writing any test. Headless, it needs the seams already agreed in the spec or ticket, or it stalls or assumes. It also runs `code-review` before committing | Factory: close or relabel the ticket, push, open the PR |
| **implement-spec** (user) | A spec with tickets | One **integration branch**; implementer subagents per frontier ticket, each in its own worktree; a merger subagent; one final `code-review` plus a fix subagent; optional draft PR | **AFK inside one session** (agent-orchestrated). S4 says a deterministic loop beats it for truly AFK work | The PR is marked ready, or tickets are closed |
| **code-review** (model) | A **fixed point** (asks if none is given); the spec (found from issue refs in commits, an argument, or `docs/`/`specs/`/`.scratch/`, else asks) | Two reports, **Standards** and **Spec**, from parallel foreground subagents, plus a one-line summary. Report only, no fixes | **AFK if given a fixed point and the spec**. Reviews `git diff <fp>...HEAD`, so uncommitted work is invisible. A known bug lets subagents recurse (50+ agents seen); the guard is to add "do not invoke /code-review or spawn agents" to the briefs. It never converges, so don't loop it to clean | Fix pass, then PR |
| **pr** (model) | The change | PR **body** only: Summary (the smallest visual), Evidence (before and after), Merge Danger (one-way or two-way door, blast radius) | AFK | Factory runs `gh pr create` |
| **triage** (user) | Unlabelled or `needs-*` issues, or a named issue or PR | Labels, agent-brief comments, `.out-of-scope/` entries, closes. Every comment starts with an "AI-generated during triage" disclaimer | **HITL**: recommends, then waits for direction. Only for issues you didn't create; tickets from `/to-tickets` are already `ready-for-agent` | `/implement` |
| **research** (model) | A question | One cited Markdown file in the repo | **AFK** (a background agent) | Feeds grilling or a ticket resolution |
| **prototype** (model) | A design question | A throwaway runnable artifact on a `prototype/<name>` branch | **HITL** (asks which question if the human is around; otherwise assumes and states it) | The ticket resolution |

[verified S2 SKILL.md files and S4 docs for each row]

### 2.4 Hand-off points and context hygiene (S2 `ask-matt`)

- Run grill-with-docs, `/to-spec` and `/to-tickets` in **one unbroken context window**. Compact only at a phase boundary, and only if the session gets close to the ~150k "smart zone". [verified S2]
- Each `/implement` starts **fresh** from its ticket, which is the Ralph property. The tickets are sized to fit one fresh window. More than 100k tokens on one ticket is normal; if it is over, split the ticket. [verified S2, S4]
- Don't run parallel `/implement` sessions in **one checkout**. They share the index, HEAD and `refs/stash`. Worktrees isolate the index and HEAD but not the stash. [verified S4 `implement.md`]

### 2.5 Where the preset clashes with unattended Ralph

- These stages are **HITL by design** and need a live operator, so they belong in the "HITL with handoff to AFK" part of the factory, not in the Ralph loop: [verified S2]
  - grill-with-docs.
  - wayfinder charting, plus its grilling and prototype tickets.
  - the seam check in to-spec.
  - the breakdown approval in to-tickets.
  - triage.
- **The AFK slice of the preset** is `implement` (plus `tdd`), `code-review` and `pr`, plus wayfinder's research tickets. [verified S2]
- **`tdd`'s seam confirmation is the main AFK hazard.** The factory's AFK prompt should either say the seams in the ticket or spec are pre-agreed, or require tickets to name them. [inferred]

---

## 3. Installing and pinning the skills

### 3.1 Install routes upstream (S1, S2 README, S3)

| Route | Command | Updates | Files |
| --- | --- | --- | --- |
| Claude Code plugin (recommended upstream) | `claude plugin install mattpocock-skills@claude-plugins-official` (S1 shows the shorter `claude plugins install mattpocock-skills`) | Updates itself by default. Managed, read-only | Plugin cache. Skills namespaced `mattpocock-skills:` |
| skills.sh (`npx skills`) | `npx skills@latest add mattpocock/skills [-a claude-code] [-g] [--skill=<name>] [--copy]` | Manual: `npx skills@latest update`. Re-run `add` to pick up new skills | Editable files you own |
| Maintainer dev script | `scripts/link-skills.sh` symlinks a clone into `~/.claude/skills` and `~/.agents/skills` | `git pull` | Explicitly "not a supported installer" |

[verified S1, S2, S3]

- **Pick one route.** The plugin and skills.sh are mutually exclusive: installing both gives you every skill twice. [verified S3]
- **The plugin bundle.** `.claude-plugin/plugin.json` lists the 27 promoted skills (engineering plus productivity) at version `1.3.1`. It excludes `misc/` and `in-progress/`. [verified S2]
- **Releases.** Changesets drive them. A `chore: version skills` PR bumps `package.json` and `plugin.json`, and managed installs reinstall only when that version changes. [verified S3]
- **Main is ahead of the latest tag.** `main` is 46 commits past `v1.3.1`, with unreleased changesets touching `code-review`, `implement`, `setup`, `tdd`, `to-tickets`, `wayfinder`, `grilling` and more. [verified S2 compare]

### 3.2 How a factory run can load a pinned set

| Option | How | Pin strength | Caveats |
| --- | --- | --- | --- |
| **A. Project-scoped vendored copy** | `npx skills add mattpocock/skills -a claude-code --copy` without `-g` writes `./.claude/skills/<name>/`, which you commit to the target repo. Or copy the directories from a clone at a known SHA | Strong: the files are in git, so the worktree checkout gives the exact set | Personal skills (`~/.claude/skills`) **override** project skills with the same name (enterprise > personal > project, C2). On this machine every skill is also installed personally, so a vendored copy would be shadowed unless runs isolate `~/.claude` (container, or `--bare` plus `--add-dir`). Also lost in a Docker sandbox unless it is in the repo (R2) |
| **B. `--plugin-dir <clone@sha>`** | Clone `mattpocock/skills` at a SHA or tag into a factory cache, then `claude -p --plugin-dir <path> "/mattpocock-skills:implement #42"` | Strong. Read-only, shared across runs, no repo pollution | Namespaced names. Loading a raw repo checkout through `--plugin-dir` is **[unverified]**: the repo root does carry `.claude-plugin/plugin.json`. Check `system/init` → `plugins` / `plugin_errors` (C1) |
| **C. `--bare` plus explicit context** | `claude --bare -p … --plugin-dir … --settings … --append-system-prompt-file …` | Strongest. Nothing ambient loads: no `~/.claude` skills, hooks, CLAUDE.md or auto-memory | **`--bare` ignores OAuth/keychain and needs `ANTHROPIC_API_KEY`**, which clashes with today's Pro `/login` billing (C1). C1 says `--bare` will become the default for `-p` |
| D. Managed plugin | `claude plugin install …@claude-plugins-official` | **None**: it auto-updates | Not reproducible. Avoid for AFK runs |

[verified C1, C2, V1, R2] [inferred: the pros and cons]

**Record the pin per run.** For every run, store the skills commit SHA (or the `plugin.json` version), so a run can be reproduced and metrics compared across skill versions. [inferred]

---

## 4. Local install compared with upstream (L1)

- **Layout.** `C:\Users\Kevin\.claude\skills\<name>` are **symlinks** into `C:\Users\Kevin\.agents\skills\<name>`, which are real directories created 2026-10-09 16:48 local time. That is the layout of a global skills.sh install: a canonical copy plus a per-agent symlink. [verified L1, V1] [inferred: that skills.sh did the install]
- **What's installed.** 27 skills, exactly the promoted set in `plugin.json`, plus `find-skills` (from `vercel-labs/skills`). Nothing from `misc/` or `in-progress/`. [verified L1]
- **Content matches upstream `main`, not the latest release.** Every one of the 27 directories is **byte-identical** (`diff -rq`) to `mattpocock/skills` at `main` [`49dd158`](https://github.com/mattpocock/skills/commit/49dd158d1076134a641b33efb035946536778336). That commit is 46 commits past `v1.3.1`, so the local skills include the **unreleased** changes, for example:
  - wayfinder's research-branch and no-PR rule.
  - to-tickets' sub-issues.
  - implement fetching and stating the ticket title.
  - grilling's "yes accepts the recommendation".

  [verified L1 vs S2]
- **No pin is recorded.** `C:\Users\Kevin\.agents\.skill-lock.json` lists only `find-skills` (with a `skillFolderHash`). None of Matt's skills appear in it. Why they are missing is **[unverified]**: perhaps a different installer, or the lock was rewritten when `find-skills` was added a minute later. Either way, the only reliable pin today is the observation that the content equals `49dd158`.
- **Each skill also ships `agents/openai.yaml`** (Codex metadata), same as upstream. Claude Code ignores it. [verified S3]
- **Not Matt's skills.** `~/.claude/skills/synced/…` (Anthropic-synced skills such as pdf and docx) and `~/.claude/skills/.trash/` are unrelated. [verified L1]
- **Older names.** S1's "featured" links still use pre-v1.1 names (`/to-prd`, `/to-issues`, `/domain-model`). Upstream and the local install use `to-spec`, `to-tickets` and `domain-modeling`. [verified S1, S2]

---

## 5. Open points to carry into later tickets

- **Skill provisioning** (the map's fog). Choose between A, B and C in §3.2. Personal-over-project precedence and the Pro-login vs `--bare` conflict both matter here.
- **Completion and relabel step.** Decide who closes or relabels a ticket after `/implement`: a factory post-step or the iteration prompt. Also decide how the parent spec is kept out of the `ready-for-agent` poll.
- **Workflow preset names.** Fix them to `to-tickets`, and replace `create-mr` with "factory opens the PR, `/pr` shapes the body".
- **AFK prompt and `tdd` seams.** The AFK iteration prompt must cover `tdd`'s seam confirmation, either by declaring the seams pre-agreed or by requiring tickets to name them.
- **`code-review` recursion guard.** Recursion is a known bug and isn't fixed upstream. Watch the agent count, or add the guard to the brief.
