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

**Group**:
A named set of tasks the operator filters and labels together, such as the tickets of one spec.
_Avoid_: Project, epic, folder

**Run**:
One agent session working on a task in a single mode; a task accumulates many runs over its life.
_Avoid_: Execution, attempt, job

**Workflow preset**:
A named sequence of stages, each naming the skill, mode and model tier to use, that a task can follow.
_Avoid_: Pipeline, recipe

**Ralph loop**:
A run sequence that takes one ready ticket per iteration with fresh context, until no ticket remains, the budget is spent, or an attention request is raised.
_Avoid_: Agent loop, autopilot

**Quick launch**:
Starting AFK work from a single prompt after a short grilling.

### Control

**Operator**:
The single human who drives the factory and owns every decision and merge.
_Avoid_: User, admin

**Mode**:
Whether a task is HITL (worked live with the operator) or AFK (worked by agents alone).

**Handoff**:
Moving a task from HITL to AFK so agents carry the rest of its flow. It ends the HITL run and starts an AFK run that continues the same conversation.

**Autonomy level**:
The ceiling on what an AFK task may do unattended: L0 HITL, L1 local commits only, L2 push and open a draft PR.
_Avoid_: Permission level, trust level

**Attention request**:
A run stopping because it needs the operator.
_Avoid_: Interrupt, alert, needs-human

**Budget**:
The cap on tokens and time a task or run may consume before it must stop.

### Measurement

**Usage window**:
The rolling period over which a Claude subscription meters consumption, and the share of it already spent.
_Avoid_: Rate limit, quota
