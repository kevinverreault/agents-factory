# Agent Factory

A local-first factory where one operator launches, groups, steers and reviews work delegated to AI agents, from live conversation through to unattended end-to-end delivery.

## Language

### Work

**Task**:
A unit of work the operator wants done, carrying a goal, labels, a mode and an autonomy level.
_Avoid_: Job, ticket, work-item

**Task tree**:
A task together with the child tasks delegated from it, recursively.
_Avoid_: Problem tree, subtask hierarchy

**Root task**:
The task at the top of a task tree, and the only one in it the operator reviews and merges; its descendants report their results upward instead.
_Avoid_: Parent task (unless one level is meant), epic

**Task branch**:
The one branch a root task's work accumulates on, from launch to its PR.
_Avoid_: Feature branch, work branch

**Child task**:
A task an agent delegated from another task's run. It is always AFK, works on its own branch, and reports to its parent instead of being reviewed.
_Avoid_: Subtask, subagent

**Awaited child**:
A child task whose report its parent's run waits for before continuing; its work can join the parent's branch.

**Fire-and-forget child**:
A child task its parent doesn't wait for; its work never joins the parent's branch.

**Child report**:
What a child task hands its parent when it ends: a summary, a status, and where its work is.
_Avoid_: Result, return value

**Research child**:
A fire-and-forget child task that resolves one research ticket of a map, at L1, on its own `research/<name>` branch, which the factory pushes when its commits touch only `docs/research/**`; its ticket closes when it reports.

**Factory note**:
A message the factory puts into a HITL conversation on its own behalf, such as a fire-and-forget child's report.
_Avoid_: System message, notification

**Group**:
A named label the operator filters tasks by, such as the tickets of one spec; it has no lifecycle of its own.
_Avoid_: Project, epic, folder

**Repository**:
A GitHub repository the operator has registered with the factory through their own clone; every task tree works in exactly one.
_Avoid_: Project, workspace, target

**Run**:
One agent session working on a task in a single mode; a task accumulates many runs over its life.
_Avoid_: Execution, attempt, job

**In-run subagent**:
A helper agent working inside a single run, invisible to the factory except in that run's usage.
_Avoid_: Child, worker

**Workflow preset**:
A named sequence of stages a task follows, frozen onto the task when it launches.
_Avoid_: Pipeline, recipe

**Stage**:
One step of a workflow preset: an agent run of one skill, a work loop, a spec task's launching of ticket tasks, or a factory action, with its own mode, model tier and autonomy ceiling.
_Avoid_: Step, phase

**Model tier**:
The class of model a stage or run asks for, resolved to an exact model when the run starts. A delegating agent can only ask for its own tier or a lower one.
_Avoid_: Model, size

**Routing table**:
The operator's map from each model tier to one exact model ID. It starts as the models the factory ships, and only an explicit `models update` moves a tier, so a model never changes under a task by surprise.
_Avoid_: Model map, aliases

**Skill set**:
The pinned collection of skills a task's stages invoke: an upstream skill library at one fixed revision plus the factory's own skills. A task freezes its skill set when it launches, and only an explicit upgrade moves the pin for later tasks.
_Avoid_: Bundle, plugin, skill pack

**Code intelligence plugin**:
The local plugin, `factory-lsp`, that gives AFK runs a pinned TypeScript language server, so they get the `LSP` tool and see the type errors their edits introduce. It's not part of the skill set, and it's the same for every task.
_Avoid_: LSP plugin (for the domain term), language server

**Security guidance plugin**:
The local plugin, `factory-security`, that warns AFK runs when an edit writes a known-dangerous pattern, such as `child_process.exec` or raw `innerHTML`, so they can fix it before they end. It's upstream's `security-guidance` pattern warnings alone, with no review that calls a model. It's not part of the skill set, and it's the same for every task.
_Avoid_: Security review (that is the upstream plugin's model-driven review, which runs don't get)

**Spec**:
The GitHub issue describing one piece of work end to end, whose sub-issues are the tickets that build it. It closes once its last ticket does.
_Avoid_: PRD, epic, plan

**Spec task**:
A root task that works out a spec and its tickets with the operator, then launches a ticket task for each ticket as it becomes takeable. It has no PR of its own, and ends once its spec closes.
_Avoid_: Parent task, coordinator, epic task

**Ticket set**:
The spec and the tickets a spec task launches ticket tasks for, which the operator confirms on the handoff sheet.
_Avoid_: Ticket list, backlog

**Spec candidate**:
An issue a task recorded, at any stage, that has sub-issues: at its handoff, it could be the spec of its ticket set. Tickets linked to an issue only by text ("Part of #n") are no sub-issues, so they don't make it one.
_Avoid_: Possible spec, spec guess

**Ticket task**:
A root task the factory launches for one ticket of a spec, once all of that ticket's blockers are merged. It has its own task branch and PR, and its ticket closes when that PR merges.
_Avoid_: Ticket child, iteration, slice task

**Held back**:
A spec's ticket labelled neither `ready-for-agent` (an AFK ticket task) nor `ready-for-human` (a HITL one): its spec task never launches it until it is relabelled.
_Avoid_: Untriaged

**Skipped ticket**:
A spec's ticket whose ticket task the operator cancelled: it stays open, its spec task never launches it again unless the operator relaunches it, and the tickets it blocks stay blocked. Once nothing more can be launched, the spec task asks the operator to relaunch it, end leaving the spec open, or close the spec anyway.
_Avoid_: Dropped ticket, abandoned ticket

**Map**:
The GitHub issue a wayfinder task charts, whose sub-issues are the decision tickets that clear the way to its destination. It is never a ticket itself. It closes right after the spec written from it, or as its task ends at the cleared map; with the spec jumped over, it stands in for the spec, its open sub-issues being the ticket set.
_Avoid_: Plan, epic

**Frontier**:
A map's or spec's open tickets with no open blockers, in sub-issue order: the ones takeable now.
_Avoid_: Backlog, next up

**Work loop**:
The HITL loop over a map: the operator picks a frontier ticket (or takes the first), works it in a fresh conversation, and the factory reads the map again, until the map has no open ticket. Unlike a spec task's tickets, the operator picks.
_Avoid_: HITL Ralph loop, map loop

**Ticket**:
A sub-issue of a spec or a map: a vertical slice of a spec, worked by its own ticket task, or a decision on a map, worked in one session of a work loop. It is an artifact a task reads, never a task itself.
_Avoid_: Work item, slice

**Artifact**:
A file or GitHub issue a run produced that the factory links to its task, such as a glossary edit, an ADR or an issue.
_Avoid_: Output, deliverable

**Quick launch**:
Starting AFK work from a single prompt after a short grilling of at most three questions, ending in a handoff.

**Launch card**:
Where the operator starts a task: they pick its repository, workflow preset and start stage, give the prompt or issue refs the start stage needs, and tag it with groups and a model tier.
_Avoid_: New task dialog, launcher

**Launch summary**:
A few sentences saying what a root task was launched to do, written with its title and branch name by the cheap run that names it at launch. Its PR body falls back to it when no stage wrote one and it has no handoff brief.
_Avoid_: Task summary, prompt summary

### Control

**Operator**:
The single human who drives the factory and owns every decision and merge.
_Avoid_: User, admin

**Mode**:
Whether a task is HITL (worked live with the operator) or AFK (worked by agents alone).

**Handoff**:
Moving a task from HITL to AFK so agents carry the rest of its flow. The operator always confirms it. It ends the HITL run and starts an AFK run that continues the same conversation, or a fresh one seeded with the handoff brief.

**Handoff brief**:
The summary a HITL run writes as its last turn when handed off (goal, decisions, done-when, out of scope, links). The operator edits it, and the AFK run receives it as its first message.
_Avoid_: Handoff summary, handover note

**Handoff sheet**:
Where the operator reviews and edits the handoff brief and confirms a handoff, with continue-as, autonomy level, model tier and max turns pre-filled from the next AFK stage. Opening it is never a commitment: backing out keeps the conversation going.
_Avoid_: Handoff dialog, handover form

**Intent**:
An operator or agent verb with steps outside the store, journaled before its first such step. After a crash, the next daemon finishes it or rolls it back before it reconciles runs. A handoff's commit, a spawn's worktree, a ticket task's launch (its worktree cut from its spec task's branch), a takeover's container restart and a factory merge (marking the PR ready, then merging it) each get an intent row. A cleanup waits on its task instead.
_Avoid_: Transaction, pending operation

**Advance sheet**:
Where the operator moves a HITL task on to its next HITL stage, when the agent proposes it or whenever they choose, skipping optional stages on the way. Only the operator advances; the agent can only propose.
_Avoid_: Next-stage dialog, stage picker

**Takeover**:
Moving a live AFK task back to HITL so the operator converses with it on the same conversation; the reverse of a handoff.
_Avoid_: Reverse handoff, hijack

**Autonomy level**:
The ceiling on what an AFK task may do unattended: at L1 the task's code stays on the operator's machine, at L2 it runs in a sandbox and the factory may push it and open a draft PR, and at L3 the factory may also merge that PR into the base branch, when its merge policy lets it. HITL tasks have none.
_Avoid_: Permission level, trust level

**Scratch folder**:
The folder in an L2 task's container, outside its clone, where its runs keep files that aren't the work and where the operator puts files a run asks for. It lasts as long as the container, and the git guards never look at it.
_Avoid_: Hand-over folder, temp dir (an L1 run's scratch space is the temp folder)

**Merge gate**:
Where an AFK root task's PR waits until it is merged into the base branch. Its merge policy decides who lets it through, and nothing passes it while the PR's checks are failing.
_Avoid_: Approval, review step

**Update run**:
The run the factory queues on a ticket task In review, or on a root waiting at an agent policy's merge gate, once GitHub finds its PR conflicting with the base branch. It resumes the task's session, merges `origin/<base>` into the task branch and resolves the conflicts, and the task goes back In review, or to its gate.
_Avoid_: Rebase run, conflict fix

**Merge policy**:
Who passes a task's merge gate, picked at handoff, or at launch for a task starting AFK, and inherited by a spec's ticket tasks. Under **operator**, the task goes In review and the operator merges it. Under **judged** (semi-auto), the factory merges unless its gate check finds the PR worth the operator's review. Under **unattended** (full-auto), the factory merges every PR whose checks pass. Judged and unattended, the **agent policies**, need L3.
_Avoid_: Auto-merge setting, review mode, auto (that is Claude Code's permission mode)

**Gate check**:
The judged policy's look at a PR at its merge gate: its tripwires first, then a judging run against the operator's rubric, ending in a merge or in the task In review with the reason.
_Avoid_: Merge review, approval

**Tripwire**:
A rule of the gate check, evaluated without a model, that sends a PR to the operator whatever the judging run would say, such as one touching database migrations.
_Avoid_: Guard, blocker (a blocker is a ticket's)

**Judgement call**:
A decision the factory made where an attended task would have asked the operator: an unattended run's assumed answer to a question, a judged merge and its reason, or a merge with review findings left over. Each is listed on the task's spec, or on its ticket when it has no spec.
_Avoid_: Assumption, auto-decision

**Factory identity**:
The GitHub identity the factory acts under for AFK work, distinct from the operator's own. HITL work stays under the operator's identity. One exception: once a setup task reaches review, the factory pushes its branch and opens its draft PR under this identity, HITL or not (ADR 0010).
_Avoid_: Bot account, service account

**Attention request**:
An AFK run's call for an operator answer, permission or decision, raised when it needs one or fails.
_Avoid_: Interrupt, alert, needs-human

**Permission card**:
A HITL run's call that no rule covers, waiting in its conversation for the operator to allow or deny it. Unlike an attention request it suspends nothing, and it ends with the agent's turn.
_Avoid_: Permission prompt, HITL request

**Parked run**:
A run ended while it waited on the operator, either suspended on an attention request or a HITL run left idle. Answering or reopening it starts a new run on the same conversation.

**Attention queue**:
Everything waiting on the operator: open attention requests, root tasks in review, and HITL tasks ready for their turn.
_Avoid_: Inbox, notifications

**Slot**:
One of the fixed number of AFK runs (8 by default) the factory lets be active at once. HITL runs and suspended runs hold none.
_Avoid_: Worker, lane

### Measurement

**Usage window**:
The rolling period over which a Claude subscription meters consumption, and the share of it already spent.
_Avoid_: Rate limit, quota

**Usage snapshot**:
The factory's latest reading of a usage window: how much is spent and when it resets. A snapshot past its reset, or too old to trust, counts as unknown.
_Avoid_: Quota reading, rate-limit status

**API-equivalent cost**:
What a run's tokens would cost at API prices, shown beside token counts so usage compares across models. On a subscription it is notional: nothing is paid.
_Avoid_: Price, spend
