---
status: accepted
---

# L3 lets the factory merge; merge policies decide when

The operator wants AFK work to reach the base branch without them: semi-auto, where the factory merges unless it judges a PR worth their review, and full-auto, where nothing after the handoff waits on them. ADR 0007 defines an **autonomy level** as a ceiling on where code runs and what the factory publishes, and merging into the base branch is the largest publish there is. ADR 0013 already gave each ticket task a **merge gate** and planned an "agent" **merge policy**. So we keep the two axes apart. A new level, **L3**, is L2 plus "the factory may merge the task's PR into the base branch". Two new merge policies decide when it does: **judged** (semi-auto) and **unattended** (full-auto), beside **operator**. Both need L3. On GitHub Free nothing on GitHub's side stops the App from merging to `main`, so this ceiling is the guard. Specified in [Semi-auto and full-auto](https://github.com/kevinverreault/agents-factory/issues/177).

## Decisions

- **The level.** L3 runs exactly as L2 does (container, `bypassPermissions`, egress proxy) and adds one factory action, merging, which only the merge policy triggers. A stage's `autonomy: L2` ceiling in a preset still forbids it. Dropping a task below L3 drops its policy to `operator`.

- **The merge gate covers every AFK root task that opens a PR,** not only ticket tasks: a single run on a brief, a quick launch, a ticket-less handoff. A spec task still has no PR, and the factory still closes the spec when its last ticket closes (ADR 0013).

- **Picking the policy.** The handoff sheet offers it next to autonomy, defaulting to `operator`, with `judged` and `unattended` offered only at L3 and labelled semi-auto and full-auto in the TUI. The launch card offers it when a task starts AFK. It can change on a live task like the level. A spec task's ticket tasks inherit it, and a change on the spec task applies to those not yet at their gate. `ready-for-human` tickets still launch as HITL ticket tasks under every policy. Their handoff sheet pre-fills the spec's policy.

- **Full-auto starts at the handoff.** The operator still grills, confirms the spec and tickets, answers questions before `implement`, and confirms the handoff. Running the HITL stages AFK is a separate, later question.

- **Checks gate every merge.** The factory merges only once the PR's checks are green, and a repo with no checks merges on review alone. A red check gets one fix run, as a conflict gets an update run. Still red, the task goes In review under `judged`, or raises an attention request under `unattended`. The App gains Checks:read and Statuses:read. When L3 is picked, the handoff sheet and launch card check that the installation grants them, and refuse L3 with the reason and a link if not, with no fallback to L2 (ADR 0004).

- **The gate check (judged).** The `review` stage with fix-once is unchanged. Once the PR is green, the gate check runs:
  1. **Tripwires**, evaluated without a model on the commits the factory's AFK runs made (by the bot's authorship). The operator's HITL commits, such as a spec task's glossary and ADR edits, never trip them. One firing puts the task In review, naming it.
  2. Otherwise **a judging run** (sonnet tier) reads the diff, the ticket and spec, the findings fix-once left over, and the operator's rubric, then merges or puts the task In review with its reason in the attention queue.

  A new commit (update run, CI fix run) voids the last gate check, and it runs again once the checks are green.

- **Unattended merges whatever the review left,** once checks are green: no tripwires, no judging run. A run's `AskUserQuestion` is not put to the operator. The run is told to take the most reasonable answer and record it. Failures and `stage-blocked` still raise attention requests: "no HITL" means the factory never chooses to stop for the operator, not that broken work merges. Under `judged`, questions reach the operator as at L2.

- **Judgement calls are recorded on the issue.** An unattended run's assumed answers, a judged merge and its reason, and a merge with findings left over are listed in the PR body. When a ticket task's PR merges, the factory also comments them on the spec, or on the ticket when there is no spec. A task with no issue has only its PR body.

- **The gate's configuration is the operator's, never the repo's.** Built-in defaults ship with the factory. `~/.agent-factory/merge-gate.yaml` optionally overrides them field by field, with per-repository sections on top. Nothing is read from the target repo: like permissions (ADR 0007), a cloned repo could otherwise loosen its own gate or write "always merge" into the rubric. The task freezes the resolved config at handoff, and `agents-factory merge-gate` prints it for a repo. The defaults:
  - tripwires: touching `**/migrations/**`, `.github/**`, `docs/adr/**` or CI and deploy config; adding or upgrading a dependency; deleting or skipping tests; a high-severity finding left after fix-once;
  - rubric: the PR goes beyond or short of the ticket's done-when; it changes behaviour or an interface others rely on in a way the spec doesn't say; it touches security-sensitive code; it settled an ambiguity by an assumption the operator might not share; it's irreversible once deployed.

- **Merging.** The factory marks the draft ready and merges with a merge commit by default, keeping the bot's trailers and the operator's HITL commits apart (ADR 0004). The method can be overridden per repository in `merge-gate.yaml`. The merge is journaled as an intent (ADR 0003): a crash mid-merge is finished, or found done, by the next daemon reading the PR, so a PR is never left half-merged nor merged twice. Cleanup follows as for any merged PR (ADR 0011).

## Considered options

- **Two levels, L3 (semi) and L4 (full).** Rejected: they would share containment and publishing rights and differ only in how the factory decides, which is a policy, not a ceiling.
- **Merge policies alone, at L2.** Rejected: a level would no longer tell the operator whether the factory might touch `main`, and preset ceilings couldn't forbid it.
- **Gate config in the repo.** Rejected for the same reason ADR 0007 refuses repo-scoped permissions.
- **Several specialized reviews in parallel at the gate** (ADR 0013's sketch). Deferred: tripwires plus one judging run is the smallest gate that works.
- **A diff-size tripwire.** Rejected by the operator: size alone doesn't say a PR needs them.
- **Squash merges.** Rejected as the default: they fold the bot's commits and the operator's HITL commits into one, losing ADR 0004's attribution.

## Consequences

- ADR 0007's levels table gains an L3 column. ADR 0013's merge gate now covers every AFK root task, and its planned "agent" policy is `judged`. ADR 0004's App gains Checks:read and Statuses:read.
- Chains of dependent tickets no longer move at the operator's merge pace under `judged` or `unattended`.
- A bad merge reaches `main` with no human in the loop. The judgement calls on the spec are how the operator audits it afterwards.
