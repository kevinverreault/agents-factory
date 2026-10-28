---
status: accepted
---

# Agents delegate through child tasks the parent merges, and model tiers only go down the tree

Agents in a run can hand work to a **child task** through the factory's MCP tools. A child gets its own run lifecycle: a **slot**, its own branch, attention requests, and visibility in the TUI. **In-run subagents** (Claude Code's Agent tool) stay available for exploration and parallel reading inside one run. Children never write into the root's worktree, and only the **root task** is reviewed (one PR), so a child's code has to rejoin the parent's branch somehow. We chose to have the **parent's own next run merge it**, because the parent knows what it asked for and is best placed to resolve conflicts. v1 has no budgets (ADR 0008). Without them, the only brakes on a task tree are depth and fan-out limits and a **model tier** that can only go down the tree. Decided in [How do agents delegate child tasks and pick model tiers?](https://github.com/kevinverreault/agents-factory/issues/14).

## Decisions

- **The tool surface.** One set of plain handlers over the store, bound to the SDK through `createSdkMcpServer` (ADR 0001). A tool that doesn't apply to a run kind isn't registered on it.

  | Tool | Root AFK | Child AFK | HITL |
  |---|---|---|---|
  | `spawn_child({goal, skill?, tier?, autonomy?, await?})` | ✓ | ✓ (within depth) | ✓, fire-and-forget only |
  | `list_children()` | ✓ | ✓ | ✓ |
  | `cancel_child({id})` (own children, cascading) | ✓ | ✓ | ✓ |
  | `report_progress({status})` | ✓ | ✓ | — |
  | `report_result({summary, status, notes})` | — | ✓ | — |
  | `propose_advance` / `propose_handoff` | — | — | ✓ |

  There is no "raise an attention request" tool. Questions and decisions go through `AskUserQuestion`, which reaches the operator through `canUseTool` in every mode (ADR 0007), and the factory raises failures itself. `report_progress` sets a one-line status for the Tasks row and is never delivered to the parent.

- **What a child runs.** It runs the built-in one-stage `child` preset: one AFK `run`, with no review and no PR, and the global `max_turns`. Its first message is `/factory:<skill> <goal>` (or the bare goal), followed by a factory context block: the root's goal and links, the parent task, the child branch and its base commit, the depth and fan-out left, and how to report. The parent's conversation isn't included, so the goal must stand on its own.

- **Defaults at spawn.**
  - `autonomy`: the parent's level (L1 under HITL). It can be lowered, never raised, and research children stay L1 (ADR 0007).
  - `await`: true from AFK runs, and always false from HITL runs.
  - The child gets a frozen copy of the parent's per-task rules and egress hosts.
  - Spawning is a **journaled intent** (ADR 0003), keyed by run id and the SDK `tool_use_id`. A replay returns the existing child.

- **Waiting is implicit.** There is no await tool. The agent spawns **awaited children**, keeps doing whatever doesn't depend on them, and ends its turn. A run that ends with any awaited child still open has the outcome `waiting on children`, whatever the agent said, and frees its slot. When the last awaited child is Done or Cancelled, the parent is queued as continuing work, and its new run resumes the session.

- **The child report.** A child ends by calling `report_result`. If it doesn't, the factory uses its final result text as the summary. The factory adds the facts it already holds: the child branch and commits, captured artifacts, and the run outcome. The resumed parent's first message holds one report per awaited child, and an operator-cancelled child reports `cancelled`. A failed child raises its own attention request, which bubbles up to the root, and its parent keeps waiting. A HITL run gets its fire-and-forget children's reports as factory notes in the conversation, or in its next run if it was parked.

- **Children work on their own branch, and the parent merges it.**
  - Every child gets a branch `<task-branch>--c<n>` and its own worktree, created even if it may not write code.
  - The branch is cut from the parent's tip at spawn. An L2 parent's commits are bundled out first.
  - An L2 child clones its branch into its own container and bundles back after each run.
  - Child branches are never pushed.
  - Before an awaited parent resumes, the factory fetches each child branch into the parent's worktree or container. The parent run merges it with a local `git merge`, which passes the ancestor check after the run (ADR 0007).
  - If the merge conflicts and the parent can't resolve it, the run ends `failed` with the normal failure request.
  - **Fire-and-forget children** never contribute code to the root, since the root may be merged before they end. Their output is artifacts only: issues, or a research branch under ADR 0007's `docs/research/**` exception.

- **Limits.** Max depth 2 (root → child → grandchild), at most 5 children per task over its life, and at most 12 descendants per tree. These are global defaults, and a preset can lower them but never raise them. Hitting a limit makes `spawn_child` return an error to the agent, with no attention request. The slot cap still governs concurrency.

- **Model tiers.**
  - Tiers are named `opus`, `sonnet` and `haiku`.
  - The routing table `~/.agent-factory/models.yaml` maps each tier to an exact model ID, never an SDK alias. The factory ships the defaults and moves them only through an explicit `factory models update`.
  - A run's tier is resolved when the run starts, and the model is recorded on the run.
  - Who chooses, most specific first: the operator (launch card, handoff sheet, retry or answer, a per-task override), then the delegating agent (`tier` at spawn), then the stage default from the frozen preset, then the global default (`sonnet`).
  - **An agent may only choose a tier at or below its own run's tier**, and a child's default is clamped the same way. The operator is unbounded.
  - No mid-run `setModel`, no `fallbackModel`, and no automatic routing by task size.
  - Routing is one small module, `route(tier) → {provider: 'claude', model}`, called by the scheduler next to choosing the credential profile.

- **Awaited children in a Ralph loop.** An iteration run that ends `waiting on children` pauses its ticket. The loop doesn't advance, and it gives up its slot. When the children report, the next run resumes that ticket's session. The iteration's success check (ADR 0006) applies to the run that finally ends `completed`, after any child branches are merged.

- **The operator controls children like any AFK task.** They can open, take over, retry, cancel and re-tier a child from the tree. After a takeover is handed back, the child still reports to its parent.

## Considered options

- **Children push their own branch or open PRs into the task branch.** Rejected: only the root is reviewed, and AFK runs never push (ADR 0004).
- **The factory merges child branches mechanically before resuming the parent.** Rejected: a conflict would need either an agent anyway or the operator, and the parent already has the context.
- **An explicit `await_children` tool that blocks or suspends the run.** Rejected: lifecycle rules already end a waiting run, and blocking inside a tool call would hold the session open for an unknown time.
- **A factory tool for attention requests.** Rejected: it would duplicate `AskUserQuestion`, which already reaches the operator in every mode.
- **Agents choose any tier.** Rejected: with no budgets, a sonnet run fanning out opus children could drain the usage window unseen. Clamping keeps the operator's choice as the ceiling for each task tree.
- **Abstract tier names (`deep` / `standard` / `light`).** Rejected for v1: routing is Claude-only, and the family names are what the operator reads. Routing elsewhere is still open.
- **SDK aliases (`opus`) passed straight through.** Rejected: an alias moves under a task with no explicit step, as an unpinned skill would.

## Consequences

- ADR 0001's tool list is amended: no "raise an attention request" tool.
- Every child costs a worktree, and an L2 child also costs a container, even if it writes nothing. Cleaning them up joins worktree and container lifecycle, which is still open.
- A child branch that a fire-and-forget child committed to is left behind unmerged. The tree in the TUI shows it.
- A merge conflict becomes a parent run failure, not a separate kind of attention request.
- A long task can see a newer model mid-flight after `factory models update`. Every run records the exact model it used.
