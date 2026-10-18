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

**Group**:
A named label the operator filters tasks by, such as the tickets of one spec; it has no lifecycle of its own.
_Avoid_: Project, epic, folder

**Run**:
One agent session working on a task in a single mode; a task accumulates many runs over its life.
_Avoid_: Execution, attempt, job

**Workflow preset**:
A named sequence of stages a task follows, frozen onto the task when it launches.
_Avoid_: Pipeline, recipe

**Stage**:
One step of a workflow preset: an agent run of one skill, a Ralph loop, or a factory action, with its own mode, model tier, autonomy ceiling and budget.
_Avoid_: Step, phase

**Ralph loop**:
A run sequence that takes one ready ticket per iteration with fresh context, until no ticket remains, the budget is spent, or an attention request is raised.
_Avoid_: Agent loop, autopilot

**Artifact**:
A file or GitHub issue a run produced that the factory links to its task, such as a glossary edit, an ADR or an issue.
_Avoid_: Output, deliverable

**Quick launch**:
Starting AFK work from a single prompt after a short grilling of at most three questions, ending in a handoff.

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

**Takeover**:
Moving a live AFK task back to HITL so the operator converses with it on the same conversation; the reverse of a handoff.
_Avoid_: Reverse handoff, hijack

**Autonomy level**:
The ceiling on what an AFK task may do unattended: L1 local commits only, L2 push and open a draft PR. HITL tasks have none.
_Avoid_: Permission level, trust level

**Factory identity**:
The GitHub identity the factory acts under for AFK work, distinct from the operator's own. HITL work stays under the operator's identity.
_Avoid_: Bot account, service account

**Attention request**:
An AFK run's call for an operator answer, permission or decision, raised when it needs one, fails, or spends its budget.
_Avoid_: Interrupt, alert, needs-human

**Parked run**:
A run ended while it waited on the operator, either suspended on an attention request or a HITL run left idle. Answering or reopening it starts a new run on the same conversation.

**Attention queue**:
Everything waiting on the operator: open attention requests, root tasks in review, and HITL tasks ready for their turn.
_Avoid_: Inbox, notifications

**Budget**:
The cap on tokens and time a task or run may consume before it must stop.

### Measurement

**Usage window**:
The rolling period over which a Claude subscription meters consumption, and the share of it already spent.
_Avoid_: Rate limit, quota
