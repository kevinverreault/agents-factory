# Workflow presets

A **workflow preset** is the sequence of **stages** a task follows. A task freezes its preset when it launches: editing a preset file later never changes a task already in flight. The decisions behind the format are in [#12](https://github.com/kevinverreault/agents-factory/issues/12), amended by ADR 0008 (`max_turns`, no `budget`).

## Where presets live

A preset is a YAML file named `<name>.preset.yaml`, in one of three scopes:

| Scope | Where | Read |
|---|---|---|
| Built-in | `src/presets/built-in/` | Shipped with the factory: `main-flow`, `wayfinder`, `quick`, `implement`, `child`, `setup` |
| User | `~/.agent-factory/presets/` | From disk, at every launch |
| Repo | `.agent-factory/presets/` in the repository | Through git, as committed at `origin/<base_branch>`, freshly fetched at launch (the launch card lists what was last fetched) |

When two scopes have a preset of the same name, repo wins over user, and user over built-in. A launched task records which file won (its source and path), a hash of the resolved stages, and the `origin/<base_branch>` commit the repo scope was read from.

A repository's `default_preset` lives in the factory's store, never in the repo. When it no longer resolves, the launch card picks `main-flow` and says why.

## A preset file

```yaml
description: Grill with me, then implement and review unattended.
stages:
  - id: grill
    kind: run
    skill: grill-with-docs
    args: "{{prompt}}"
    mode: HITL
    model: opus
  - id: implement
    kind: loop
    skill: implement
    args: "{{artifacts.tickets}}"
    mode: AFK
    model: sonnet
    exit: tickets-closed
```

Preset fields: `description`, `stages`, and `extends` + `from` (below). Anything else is refused.

Stage fields:

| Field | Values |
|---|---|
| `id` | Lowercase letters, digits and dashes, unique in the preset |
| `kind` | `run` (one agent run of a skill), `loop` (repeated runs over tickets) or `action` (a factory step with no agent) |
| `skill` | A skill of the skill set, invoked as `/factory:<skill>`. A `loop` needs one; a `run` without one sends its `args` as they are; an `action` has none |
| `args` | A template: `{{prompt}}` and `{{artifacts.<kind>}}`, with kinds `map`, `spec`, `tickets`, `pr-body` |
| `mode` | `HITL` or `AFK` |
| `model` | A model tier: `opus`, `sonnet` or `haiku` |
| `autonomy` | `L1` or `L2`, the ceiling an AFK stage may run at. HITL stages have none |
| `max_turns` | A whole number of at least 1, the runaway guard of an AFK stage's runs: hitting it ends the run `failed` with a failure attention request. Without it a run gets the global default of 300; the launch card's max turns overrides both |
| `context` | `resume` (the default) or `fresh` |
| `optional` | `true` when the advance sheet may skip it |
| `exit` | `run-completed`, `artifact:<kind>`, `tickets-closed` or `map-cleared`. A HITL stage without one advances when the operator confirms |
| `requires` | `L2` |
| `on_findings` | `fix-once` |

An `action` stage's `id` names its factory action: `open-pr`, `close-ticket` or `push`. There is no `entry` field: a stage starts when the previous stage's exit holds and its `args` can be filled.

## Extending a preset

```yaml
extends: main-flow
stages:
  - id: implement      # overrides these fields of main-flow's implement
    model: opus
  - id: lint           # new: goes before the next stage this file overrides
    kind: run
    skill: lint
    mode: AFK
  - id: review
```

A preset that `extends` another takes its stages, overrides single ones by `id` field by field, and inserts each new stage before the next one it overrides (or last, after them all). `from: <stage id>` takes the extended preset's stages from that stage onward only: `wayfinder` extends `main-flow` from `spec`, and `implement` extends `quick` from `implement`, starting it on the prompt. A preset extending its own name extends the one it shadows in a lower scope, so a repo can tweak the built-in `main-flow` by one stage. Other presets extending `main-flow` then extend that tweak.

The resolved stages are checked whole against the schema at launch. A preset that fails, names an unknown exit condition or template, or extends one that is missing or itself is refused with the reason.

## Starting at a stage

The launch card's start stage picker offers the stages whose `args` the launch inputs can fill: the prompt fills `{{prompt}}`, and issue refs stand for the issue artifacts (`map`, `spec`, `tickets`) earlier stages would have made. The first stage is offered even when it needs no input (`setup`); a later stage that needs none isn't, since it works from what earlier stages left. A stage needing an artifact no launch input stands for (`pr-body`) is never offered. Starting `main-flow` at `implement` with issue refs makes the task AFK from its first run, at L1. Until the Ralph loop arrives, that first run gets every ref at once rather than one ticket per iteration (ADR 0006).

## Artifacts of a kind

`artifact:<kind>` and `{{artifacts.<kind>}}` name the task's artifacts of that kind. An issue is one of kind `spec` (or `map`, `tickets`) when it was captured during a stage whose exit is `artifact:spec`, so an issue the grill merely printed is no spec. In `args` they read as `owner/name#n`, separated by spaces. A task started past the stages that make them reads its launch issue refs instead, for the kinds its start stage's `args` name. Exits count only captured artifacts.

## Moving from stage to stage

**HITL → HITL.** The agent may call `propose_advance` on the factory MCP server. The proposal shows as a banner in the conversation and changes nothing else; the operator's next message sets it aside. Only the operator advances, on the advance sheet (`ctrl+n`), which lists the HITL stages up to the next AFK one and skips optional ones with `space`. Confirming:

- is refused while the stage's exit doesn't hold. `run-completed` holds, since confirming ends the run completed; `artifact:<kind>` holds once the task has an artifact of that kind. The factory can't evaluate `tickets-closed` or `map-cleared` on a HITL boundary yet.
- is refused when the next stage is AFK: the handoff starts that one.
- otherwise ends the stage's run `completed` and starts a run of the next stage, its skill invoked on its filled `args`. It resumes the session, or starts a new one with `context: fresh`, at the tier the operator picked at launch, else the stage's model tier (the task's when the stage names none).
- raises a `stage-blocked` attention request instead, naming what's missing, when the next stage's `args` can't be filled. The run still ends, and the task stays at the stage it was leaving, to advance from again once the request is answered.
- past the last stage, puts the root task in review.

**HITL → AFK.** The agent may call `propose_handoff`, shown as a banner that changes nothing else. Only the operator hands off, from any HITL stage, with `/handoff` (or `ctrl+h`, where the terminal tells it from Backspace). That interrupts an agent mid-turn, drops an open question card and any queued messages, and opens the handoff sheet. The HITL run writes the handoff brief (goal, decided, done when, out of scope, links) through `write_handoff_brief` as its last turn, and a task with no live run first resumes its session just for that. The sheet hands off to the first AFK stage from the task's own stage on, skipping the remaining HITL stages, and pre-fills its fields from that stage: continue-as (resume, or fresh from the brief once the conversation fills more than 60% of the context window), autonomy (L1 until the sandbox arrives), tier and max turns. `esc` backs out and the conversation carries on. Confirming:

- is refused until the agent has written the brief, and blocked while the task branch isn't checked out, the worktree has changes to files that are no artifact of the task, or a remote has a `pushurl`.
- commits the task's uncommitted artifacts (its glossary and ADR edits) to the task branch, under the operator's identity, as the HITL work they are.
- ends the HITL run `handed off` and queues the AFK stage's run. Its first message is the stage's skill, then the edited brief, which also becomes the task's goal of record. Args an early handoff skipped the stages for are left out, and the brief stands in for them. Fresh from the brief starts a new session.
- with no AFK stage ahead (or no preset), queues one AFK run on the brief, after which the root task goes In review.

**AFK → AFK.** No one confirms: when an AFK stage's run completes, the factory checks the boundary itself.

- When the stage's exit holds, the task moves to the next stage and queues its run, the skill invoked on its filled `args`, resuming the session or starting a new one with `context: fresh`. It queues as work continuing something in flight, so the scheduler gives it a slot after urgent work and before work not yet started.
- A stage that `requires: L2` is skipped below L2, so at L1 `open-pr` is.
- A `stage-blocked` attention request is raised instead, naming what's missing, when the exit doesn't hold (the factory can't evaluate `tickets-closed` or `map-cleared` yet, so those never hold), the next stage's `args` can't be filled, the next stage is HITL (take the task over to start it), or it is a factory action (none runs yet). The task stays at its stage. Answering the request sends its run on at that stage, told what was missing, and the boundary is checked again when that run completes.
- Past the last stage, the root task goes In review and shows in Needs you.

An AFK task's autonomy level changes only between runs, never under a live one, and is clamped to its stage's `autonomy` ceiling. Each run also takes its stage's ceiling.
