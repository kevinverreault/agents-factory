---
status: accepted (merge gate amended by ADR 0014)
---

# Each ticket is its own reviewed task, launched once its blockers are merged

ADR 0006 worked a spec's tickets as iterations of one root task on one task branch, with one PR, and the factory closed each ticket when it was done on that branch. In practice the operator could only review the spec as a whole. A closed ticket didn't mean "on `main`". Nothing ever closed the spec. And when the spec and tickets were written during the `grill` stage, the factory never recognised them, so `implement` ran the whole spec in one session on the handoff brief (T16). We now make each ticket a **ticket task**: a root task of its own, with its own task branch and PR into the base branch. The **spec task** that wrote the spec launches one ticket task for each **frontier** ticket, in parallel. A ticket becomes takeable once its blockers are merged. Reviewing per ticket is what lets a later version have agents pass a ticket's **merge gate** themselves.

## Decisions

- **Finding the ticket set.**
  - The factory reads the spec and its tickets from GitHub's sub-issue structure, whatever stage recorded them. Any issue the task recorded that has sub-issues is a spec candidate.
  - The handoff sheet shows what will be launched ("Spec #132 → 5 tickets, 2 ready now"). It lists the tickets held back and lets the operator correct the set.
  - With no ticket set, the sheet says the handoff is one run on the brief, which stays a single run as before.
  - Tickets linked only by text ("Part of #n") are not parsed.

- **The spec task.**
  - After the handoff, the spec task's `implement` stage launches ticket tasks instead of looping. It holds no slot and has no PR.
  - It is Done once its spec closes. Its own HITL artifacts (glossary and ADR edits) reach `main` on its ticket tasks' branches, below.

- **A ticket task.**
  - A ticket task runs the spec task's frozen preset from `implement` onward: one `implement` run on its ticket, then `review` with fix-once, `pr-body` and `open-pr`, so a repo's overrides apply to every ticket.
  - It inherits from the handoff the autonomy level, model tier, max turns, groups, and a copy of the per-task rules and egress hosts.
  - Its first message is `/factory:implement <ticket>`, then a context block: the spec, the handoff brief, and which sibling tickets are merged or in flight.
  - Its branch is cut from the spec task's branch after merging the latest `origin/<base>` into it. Whichever ticket PR merges first carries the spec task's docs; on the others they become a no-op.
  - It is a root: it may spawn children under its own tree's limits (ADR 0009), and a failure raises its own attention request while its siblings carry on.

- **Which tickets are launched.**
  - A ticket labelled `ready-for-agent` gets an AFK ticket task.
  - A `ready-for-human` ticket gets a HITL one, which shows as Ready for you.
  - Any other label, or none, is held back. When only held-back tickets remain, the spec task raises `stage-blocked` naming them.

- **Parallelism.** Every frontier ticket is launched. The slot cap is the only limit, and queued ticket tasks take slots in frontier order.

- **Blockers clear on merge.** A blocked ticket waits until every blocker's PR is merged and the blocker is closed. There are no stacked branches.

- **Resolution.**
  - Ticket PR bodies say `Closes #n`. The rewriting to `Implements #n` is dropped.
  - When the factory sees a ticket task's PR merged but its ticket still open (for example the PR targets a branch that isn't the default, or the keyword was edited away), it closes the ticket as the factory identity, naming the PR.
  - When a spec's last ticket closes, the factory closes the spec, with a comment listing each ticket and its merged PR.
  - A wayfinder map closes with the spec written from it. A map that ended at "cleared" closes when its task ends. When the spec is jumped over (ADR 0012), the map acts as the spec: its open sub-issues are the ticket set, and it closes with its last ticket.

- **Conflicts.** When the PR poll finds a ticket task's PR no longer mergeable, the factory queues a run on that task that merges `origin/<base>` into its branch and resolves the conflict. At L2 the factory pushes the result. A run that can't resolve it fails with the normal failure request.

- **Faster polling.** While any ticket task is In review, ADR 0011's PR poll runs every 2 minutes instead of 15, still one read-only GET per PR. (*Amended by ADR 0014:* so it does while any root waits at an agent policy's merge gate, which also reads the checks on its PR's head.)

- **Merge gate and merge policy.**
  - A ticket task's PR waits at a merge gate, and the spec's merge policy, frozen at handoff and inherited by its ticket tasks, decides who passes it.
  - v1 has one policy, the operator's: the ticket task goes In review and the operator merges. The handoff sheet shows no choice yet.
  - The planned next policy is "agent": several specialized reviews run in parallel on the ticket's PR, then the agent either merges it or puts the task In review for the operator when it judges that necessary.
  - *Amended by ADR 0014:* the merge gate covers every AFK root task that opens a PR, not only ticket tasks: a single run on a brief, a quick launch, a ticket-less handoff. The policy is frozen onto any task at its handoff, or at launch when it starts AFK, and the handoff sheet and launch card offer it at L3. Beside `operator` come `unattended` (full-auto), under which the factory marks the PR ready and merges it with a merge commit once its checks are green (or two reads of its head, 2 minutes apart, find none), and `judged` (semi-auto), the "agent" policy above, with one judging run rather than several reviews. A conflicting PR at an agent policy's gate gets the same update run as a ticket task's, and the PR poll runs every 2 minutes while any root waits there.

- **Cancelling.**
  - Cancelling a ticket task closes its draft PR (ADR 0011) and leaves its ticket open. The spec task marks the ticket skipped, so tickets it blocks stay blocked. Once nothing more can be launched, the spec task asks the operator to relaunch the skipped ticket, end leaving the spec open, or close the spec anyway.
  - Cancelling the spec task cancels every unmerged ticket task with one Keep branch / Discard work question for the lot. Merged ticket tasks and their closed tickets are untouched, and the spec stays open.

- **The `implement` preset.** One issue ref with no sub-issues makes the task a ticket task for it. A spec ref or several refs make a spec task with no HITL stages before it. A prompt alone is one run. With both refs and a prompt, the prompt joins each ticket task's first message as operator instructions.

- **The Ralph loop is removed.** A task still frozen on a `loop` stage with exit `tickets-closed` raises `stage-blocked` ("this preset's loop was retired: cancel or relaunch"). Nothing is migrated.

## Considered options

- **Keep one PR per spec, with tickets as parallel branches the factory merges into the task branch.** Rejected: the operator still reviews once at the end, and a ticket still isn't something an agent could merge.
- **Ticket PRs into a spec integration branch, then one spec PR into `main`.** Rejected: there are two review layers, and tickets "close" before reaching `main`, which is ADR 0006's problem one level down.
- **Stacked ticket branches, started when a blocker's PR opens.** Rejected: every fix on a blocker ripples down the stack, and each PR's diff carries its blockers until they merge. Merge-paced chains are what the agent merge policy relieves.
- **Ticket tasks as child tasks.** Rejected: a child is never reviewed and its work joins its parent's branch (ADR 0009); stretching it would blur the definition cleanup and merging rely on.
- **Stage-based capture of the spec and tickets, with only a warning.** Rejected: it depends on the operator pressing ctrl+n between skills, which T16 shows they don't.
- **A separate docs PR for the spec task's artifacts.** Rejected: the docs describe the tickets' work, so landing them with the first ticket keeps every merged state coherent.
- **A per-spec cap on parallel ticket tasks.** Rejected for now: the slot cap already bounds concurrency, and conflicts are handled explicitly.

## Consequences

- ADR 0006 is superseded. Tickets now close when their work is on `main`, not on a task branch, and the cancel cascade has no tickets to reopen.
- ADR 0011 is amended: the PR poll is faster while ticket tasks are In review, and a spec task becomes Done when its spec closes rather than when a PR merges.
- ADR 0012 is amended: the factory now closes a map when its spec closes, or when a task ending at "cleared" ends. It still never closes a map's decision tickets.
- Until the first ticket merges, every open ticket PR's diff also shows the spec task's docs commits.
- A chain of dependent tickets moves only as fast as the operator merges, until the agent merge policy exists.
- Every ticket costs its own worktree, and at L2 its own container.
