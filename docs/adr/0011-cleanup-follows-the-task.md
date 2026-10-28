---
status: accepted
---

# Cleanup follows the task, and only Cancel asks before discarding work

A task tree leaves worktrees, local and remote branches, containers, images and transcripts behind. The factory removes each of them as soon as the task that owns it ends, not after a grace period or on a timer. Cancel asks the **operator** once, and only when commits would otherwise be lost. Done never asks, because the factory only reaches Done once the work is on `main`. Leftovers that belong to no live task are cleaned only by an operator command. We chose immediate removal over a grace period because the two events that end a task already separate shipped work (Done) from work that might still be wanted (Cancel). Keeping debris around would also block the operator's clone, since git won't check out a branch whose worktree still exists (ADR 0010). Decided in [When are task and child worktrees, branches and containers removed?](https://github.com/kevinverreault/agents-factory/issues/22).

## Decisions

- **How a root task becomes Done.**
  - **Merged PR:** while any root is In review, the daemon reads its draft PR's state with the App token, when a TUI attaches and every 15 minutes, one GET per PR. A merged PR makes the task Done.
  - **Mark done:** this review action covers a root with no PR. It fetches and checks that the task branch tip is an ancestor of `origin/<base_branch>`. If not (a local squash, or never merged), it asks "Not merged into main. Finish anyway?"
  - **PR closed unmerged:** the factory raises a "PR closed unmerged" entry in the **attention queue**, with Cancel task and Reopen PR. It never cancels on its own.
- **At root Done:** remove the worktree, force-delete the local **task branch** (a squash merge fails `git branch -d`, and the merge is already confirmed), and delete the remote task branch the factory pushed, as the **factory identity** under the same fixed-refspec guard (ADR 0004). This doesn't depend on GitHub's auto-delete setting.
- **At root Cancel:** the factory closes its draft PR with a comment and deletes the remote task branch. If the local branch holds commits that are on neither `origin` nor `origin/<base_branch>`, the cancel sheet asks once: **Keep branch** (the default; it removes the worktree and container and leaves the local branch in the operator's clone) or **Discard work**. With no unique commits, everything is removed without asking.
- **Children.**
  - A child's worktree is removed as soon as it ends. The parent merges from the branch, not the worktree.
  - An **awaited child**'s branch is deleted once its tip is an ancestor of the parent's branch, which is checked after the parent run that merged it.
  - A **fire-and-forget child**'s branch is deleted when it ends, since its code can never join the root (ADR 0009). Its **child report** keeps the commit SHAs, and the `docs/research/**` branch exception (ADR 0007) covers anything meant to survive.
  - A child branch still unmerged at root Done or Cancel (for example after a failed merge) is deleted with the tree. The cleanup lists it, with no prompt.
- **Fire-and-forget children outlive a merged root.** They keep running, and the root's cleanup doesn't wait for them. Each one is cleaned up when it ends, and the tree stays visible until its last descendant finishes.
- **An L2 container lives as long as its task.** It holds the clone and the session transcripts the next run resumes from. The factory **stops** it whenever the task has no active run (In review, Needs you, Waiting on children, parked) and starts it again for the next run. At Done or Cancelled, it takes a final `git bundle` out and then runs `docker rm`. Children's containers follow the same rule.
- **Transcripts are archived, not deleted.** Before an L2 container is removed, its session transcripts are copied to `~/.agent-factory/transcripts/<task-id>/`. Host runs' transcripts are copied there when the task ends. Factory runs set a longer `cleanupPeriodDays`, so Claude Code doesn't delete them first. A finished task's conversation reads the same at every level. v1 never prunes the archive.
- **Images.** The factory keeps one tagged sandbox image per version it built. Building a newer one removes older factory-labelled images that no container uses. It never touches images it didn't build.
- **`factory gc`**, also a TUI action, runs the recovery matcher (ADR 0003) on demand: worktrees under the worktree root, `factory/*` branches, and factory-labelled containers and images that belong to no live task. It lists them and deletes only what the operator ticks. `factory repo remove` runs `gc` scoped to that repo before removing the registration. Nothing runs on a timer.
- **Cleanup is a journaled intent** (ADR 0003), so a crash mid-cleanup finishes on the next start.

## Considered options

- **A grace period before removal.** Rejected: Done already means the work is on `main`, Cancel already asks, and a lingering worktree keeps the operator from checking out the branch.
- **Only the operator marks a task Done.** Rejected as a chore for the common case, a merged PR. Mark done stays for roots without a PR.
- **Leaving remote branch deletion to GitHub's auto-delete setting.** Rejected: it is off by default, and the factory created the branch.
- **Keeping fire-and-forget children's branches.** Rejected: by design they never contribute code, so a kept branch would only accumulate.
- **Scheduled garbage collection.** Rejected for v1: every resource has an owning task whose end triggers its cleanup. Only crash debris lacks an owner, and the operator cleans that.

## Consequences

- The daemon makes one PR read per In review root every 15 minutes. This is the factory's only poll, and it reads only.
- The factory identity deletes remote `factory/*` branches and closes draft PRs, both within its existing Contents and Pull requests write.
- A kept branch from a cancelled task lives only in the operator's clone. `gc` lists it like any other `factory/*` branch.
