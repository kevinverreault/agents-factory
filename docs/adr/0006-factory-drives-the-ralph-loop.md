---
status: accepted
---

# The factory drives the Ralph loop: it picks each ticket and closes it on the task branch

Ralph and Sandcastle hand the whole item list to the agent every iteration and let it pick "the highest-priority unfinished item", then mark or close it itself. Ralph has to: its PRD has no dependency edges, so ordering is a judgement only the agent can make. The factory's tickets already carry that judgement. `/to-tickets` is a HITL stage where the **operator** approves the breakdown and its blocking edges, and it publishes the tickets as sub-issues of the spec, blockers first, with GitHub's native dependencies. So the `implement` stage's **Ralph loop** is factory code that reads that structure: the factory chooses each **ticket**, runs one fresh run on it, judges the iteration, and closes the ticket on the **task branch**. AFK runs couldn't close tickets anyway, since they hold only a read-only GitHub token (ADR 0004). Decided in [How does a Ralph loop run end to end?](https://github.com/kevinverreault/agents-factory/issues/13).

## Decisions

- **A ticket is an iteration run, not a child task.** Each ticket is worked by runs of the root task, one at a time, committing straight onto the task branch in the task's worktree (L1) or container clone (L2). There are no per-ticket branches and nothing merges back. Parallelism comes from running several tasks, not from one loop.
- **The factory picks the ticket.** Before every iteration it re-reads the ticket set from GitHub: the spec's open sub-issues (or the issue refs given at launch) labelled `ready-for-agent`, never the spec itself. The frontier is the set's open tickets with no open blockers, and the factory takes the first in sub-issue order. The run's first message names exactly that ticket (`/factory:implement <ref>` plus a factory context block: spec, progress, handoff brief, done tickets with their commits). The operator changes the order by editing the sub-issues or their blocking edges on GitHub, and the next iteration sees it.
- **The factory judges the iteration.** An iteration succeeds when its run ends `completed`, the task branch has at least one new commit, and the tree is clean. The factory runs no tests of its own in v1. Anything else raises a failure attention request (retry, which resumes that ticket's session; skip the ticket; take over; or cancel), with no automatic retry or skip.
- **A ticket closes when its work is on the task branch.** After a successful iteration, and at L2 after the iteration's push, the `close-ticket` action closes the ticket as completed with a comment naming the task branch, the commits (local at L1) and the task. GitHub's native blocking then advances the frontier by itself, and the exit condition is `tickets-closed`. The PR body lists the closed tickets as `Implements #n`, not `Closes #n`.
- **Cancelling the task reopens what it closed.** The store remembers which tickets this task closed. The cancel cascade reopens each one, with a comment that its work on the task branch was not merged, as a step of the cancel intent (ADR 0003). Skipped tickets were never closed and stay open.

## Considered options

- **The agent picks** (Ralph, Sandcastle). Rejected: the order isn't deterministic, the agent can drift onto other tickets, and the factory wouldn't know which ticket a run is on until it ended. Per-ticket retries, skip, takeover, metrics and progress all need that. A middle option, where the factory offers the first few frontier tickets and the agent claims one through an MCP tool, was set aside: the ordering judgement was already made when the operator approved `/to-tickets`.
- **Done in the store, closed on merge** through `Closes #n`. Rejected: tickets would stay open on GitHub for the whole loop and review, so GitHub's frontier and anything outside the factory would show finished work as open.
- **One PR per ticket into the task branch.** Rejected: the operator would review every ticket, but only the root task is reviewed. It still wouldn't close tickets either, because `Closes #n` only fires on a merge into the default branch.
- **A child task per ticket.** Rejected: children never write into the root's worktree, so each ticket would need its own branch and a merge back.

## Consequences

- A closed ticket means "done on the task branch", not "on `main`". Until the operator merges, GitHub shows closed tickets whose code sits in an open draft PR (or only locally at L1), and each closing comment says where.
- A PR closed without merging, while its task isn't cancelled, leaves its tickets closed. Cancelling the task is what reopens them.
- When two tickets turn out to be one piece of work, the second iteration makes no commit and fails. The operator skips it or ticks it done on a takeover.
