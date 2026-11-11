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
One step of a workflow preset: an agent run of one skill, a Ralph loop, or a factory action, with its own mode, model tier and autonomy ceiling.
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

**Ralph loop**:
A run sequence that takes one ready ticket per iteration with fresh context, until every ticket is done, the loop stalls, or the operator ends it early.
_Avoid_: Agent loop, autopilot

**Map**:
The GitHub issue a wayfinder task charts, whose sub-issues are the decision tickets that clear the way to its destination. It is never a ticket itself.
_Avoid_: Plan, epic

**Frontier**:
A map's open tickets with no open blockers, in sub-issue order: the ones takeable now.
_Avoid_: Backlog, next up

**Work loop**:
The HITL loop over a map: the operator picks a frontier ticket (or takes the first), works it in a fresh conversation, and the factory reads the map again, until the map has no open ticket. Unlike a Ralph loop, the operator picks.
_Avoid_: HITL Ralph loop, map loop

**Ticket**:
A GitHub issue a loop works through, one per iteration: a vertical slice of a spec for a Ralph loop, a decision on a map for a work loop. It is an artifact the task reads, never a task itself.
_Avoid_: Work item, slice

**Artifact**:
A file or GitHub issue a run produced that the factory links to its task, such as a glossary edit, an ADR or an issue.
_Avoid_: Output, deliverable

**Quick launch**:
Starting AFK work from a single prompt after a short grilling of at most three questions, ending in a handoff.

**Launch card**:
Where the operator starts a task: they pick its repository, workflow preset and start stage, give the prompt or issue refs the start stage needs, and tag it with groups and a model tier.
_Avoid_: New task dialog, launcher

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
An operator or agent verb with steps outside the store, journaled before its first such step. After a crash, the next daemon finishes it or rolls it back before it reconciles runs. A handoff's commit, a spawn's worktree and a takeover's container restart each get an intent row. A cancel cascade's ticket reopening and a cleanup wait on their task instead.
_Avoid_: Transaction, pending operation

**Advance sheet**:
Where the operator moves a HITL task on to its next HITL stage, when the agent proposes it or whenever they choose, skipping optional stages on the way. Only the operator advances; the agent can only propose.
_Avoid_: Next-stage dialog, stage picker

**Takeover**:
Moving a live AFK task back to HITL so the operator converses with it on the same conversation; the reverse of a handoff.
_Avoid_: Reverse handoff, hijack

**Autonomy level**:
The ceiling on what an AFK task may do unattended: at L1 the task's code stays on the operator's machine, and at L2 it runs in a sandbox and the factory may push it and open a draft PR. HITL tasks have none.
_Avoid_: Permission level, trust level

**Factory identity**:
The GitHub identity the factory acts under for AFK work, distinct from the operator's own. HITL work stays under the operator's identity.
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
One of the fixed number of AFK runs the factory lets be active at once. HITL runs and suspended runs hold none.
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
