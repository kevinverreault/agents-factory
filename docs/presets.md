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

Preset fields: `description`, `stages`, `limits`, and `extends` + `from` (below). Anything else is refused.

`limits` lowers the brakes on the task trees launched with the preset (ADR 0009): `depth` (at most 2: root → child → grandchild), `children` (at most 5 spawned by one task over its life) and `descendants` (at most 12 under one root). Each is optional and can only go down; a preset extending another overrides its limits one by one. A child task runs the built-in `child` preset, and spawns under its root's limits.

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

A preset that `extends` another takes its stages, overrides single ones by `id` field by field, and inserts each new stage before the next one it overrides (or last, after them all). `from: <stage id>` takes the extended preset's stages from that stage onward only: `wayfinder` extends `main-flow` from `spec`, and `implement` extends `main-flow` from `implement`, starting its ticket loop on issue refs, a prompt or both. A preset extending its own name extends the one it shadows in a lower scope, so a repo can tweak the built-in `main-flow` by one stage. Other presets extending `main-flow` then extend that tweak.

The resolved stages are checked whole against the schema at launch. A preset that fails, names an unknown exit condition or template, or extends one that is missing or itself is refused with the reason.

## Starting at a stage

The launch card's start stage picker offers the stages whose `args` the launch inputs can fill: the prompt fills `{{prompt}}`, and issue refs stand for the issue artifacts (`map`, `spec`, `tickets`) earlier stages would have made. The first stage is offered even when it needs no input (`setup`); a later stage that needs none isn't, since it works from what earlier stages left. A stage needing an artifact no launch input stands for (`pr-body`) is never offered. Starting `main-flow` at `implement` with issue refs makes the task AFK from its first run, at L1, and the loop runs one ticket per iteration (ADR 0006).

A stage whose `args` name both `{{prompt}}` and an issue artifact takes either: any one launch input fills it, and the other fills as empty, where every other stage needs all the variables of its `args`. `implement` is such a stage (`{{artifacts.tickets}} {{prompt}}`). Issue refs run its Ralph loop over their tickets; a prompt alone is a single run, since a loop with no ticket set runs once and its exit `tickets-closed` holds; with both, the refs drive the loop and each iteration also gets the prompt as operator instructions. An issue number typed in the prompt is not read as a ref: it reaches the skill as text. The rule holds at stage boundaries too: a task reaching such a stage with a prompt but no artifact (or the reverse) opens it on what it has, rather than raising `stage-blocked`; one with neither is blocked as usual.

## Artifacts of a kind

`artifact:<kind>` and `{{artifacts.<kind>}}` name the task's artifacts of that kind. An issue is one of kind `spec` (or `map`, `tickets`) when it was captured during a stage whose exit is `artifact:spec`, so an issue the grill merely printed is no spec. In `args` they read as `owner/name#n`, separated by spaces. A task started past the stages that make them reads its launch issue refs instead, for the kinds its start stage's `args` name. Exits count only captured artifacts.

## Moving from stage to stage

**HITL → HITL.** The agent may call `propose_advance` on the factory MCP server. The proposal shows as a banner in the conversation and changes nothing else; the operator's next message sets it aside. Only the operator advances, on the advance sheet (`ctrl+n`), which lists the HITL stages up to the next AFK one and skips optional ones with `space`. Confirming:

- is refused while the stage's exit doesn't hold. `run-completed` holds, since confirming ends the run completed; `artifact:<kind>` holds once the task has an artifact of that kind. `map-cleared` holds once the work loop's map has no open ticket (below); the factory can't evaluate `tickets-closed` on a HITL boundary yet.
- is refused when the next stage is AFK: the handoff starts that one.
- otherwise ends the stage's run `completed` and starts a run of the next stage, its skill invoked on its filled `args`. It resumes the session, or starts a new one with `context: fresh`, at the tier the operator picked at launch, else the stage's model tier (the task's when the stage names none).
- raises a `stage-blocked` attention request instead, naming what's missing, when the next stage's `args` can't be filled. The run still ends, and the task stays at the stage it was leaving, to advance from again once the request is answered.
- past the last stage, puts the root task in review.

**The work loop.** A HITL `loop` stage whose exit is `map-cleared` (wayfinder's `work`) works its map with the operator, one ticket per session (ADR 0012). Entering it starts no run: the factory reads the map's sub-issues from GitHub, and the task shows Ready for you with the map's frontier under it (the open tickets with no open blockers, in sub-issue order), while it reads "Reading the map". A digit on its sheet picks a ticket, and opening the task takes the first: either starts a fresh session on the stage's skill, its `args` and the ticket (`/factory:wayfinder <map> <ticket>`). Confirming the advance sheet on that ticket's run finishes it: the run ends `completed` and the factory reads the map again. Every open ticket blocked raises a `stage-blocked` request, and answering it reads the map again. Once the map has no open ticket, `map-cleared` holds, and the operator chooses on the task's sheet where it goes: continue to the next stage (`spec`), jump over it to the one after (`tickets`, its `{{artifacts.spec}}` filled with the map), or end, which puts the root In review.

**Quick launch.** `n` takes one prompt and launches the `quick` preset (as the repository resolves it) as a quick launch, which its start stage must be HITL for. Its grill, the factory's `quick-grill` skill, shows its questions on a small card over the screens rather than in the conversation view, and asks at most three: a card asking past them is cut to the ones left. The factory opens the handoff sheet itself, at L1 as always, once the grill is done: a turn of it ended on the operator's (so the agent has read every answer), or it asked past its three questions, which opens the sheet in place of that card, interrupting the agent. A grill resumed after a restart is done only once a turn of it ends. Opening the sheet ends the quick launch: backing out of it carries on in the conversation view. `ctrl+e` ends it too, expanding the card into the full conversation on the same session, where it is a grill like any other, and `esc` leaves it as one. `ctrl+h` (or `/handoff`) opens the sheet at any question. Confirmed, the handoff runs `quick`'s implement stage as a single AFK run on the brief, then the review and PR body; at L1 open-pr is skipped as below.

**HITL → AFK.** The agent may call `propose_handoff`, shown as a banner that changes nothing else. Only the operator hands off, from any HITL stage, with `/handoff` (or `ctrl+h`, where the terminal tells it from Backspace). That interrupts an agent mid-turn, drops an open question card and any queued messages, and opens the handoff sheet. The HITL run writes the handoff brief (goal, decided, done when, out of scope, links) through `write_handoff_brief` as its last turn, and a task with no live run first resumes its session just for that. The sheet hands off to the first AFK stage from the task's own stage on, skipping the remaining HITL stages, and pre-fills its fields from that stage: continue-as (resume, or fresh from the brief once the conversation fills more than 60% of the context window), autonomy (L1 unless the operator picks L2, whose runs execute in the task's own container), tier and max turns. `esc` backs out and the conversation carries on. Confirming:

- is refused until the agent has written the brief, and blocked while the task branch isn't checked out, the worktree has changes to files that are no artifact of the task, or a remote has a `pushurl`.
- commits the task's uncommitted artifacts (its glossary and ADR edits) to the task branch, under the operator's identity, as the HITL work they are.
- ends the HITL run `handed off` and queues the AFK stage's run. Its first message is the stage's skill, then the edited brief, which also becomes the task's goal of record. Args an early handoff skipped the stages for are left out, and the brief stands in for them. Fresh from the brief starts a new session.
- with no AFK stage ahead (or no preset), queues one AFK run on the brief, after which the root task goes In review.

**AFK → AFK.** No one confirms: when an AFK stage's run completes, the factory checks the boundary itself.

- When the stage's exit holds, the task moves to the next stage and queues its run, the skill invoked on its filled `args`, resuming the session or starting a new one with `context: fresh`. It queues as work continuing something in flight, so the scheduler gives it a slot after urgent work and before work not yet started.
- A stage that `requires: L2` is skipped below L2, so at L1 `open-pr` is, and the root reaches In review with its task branch only on the operator's machine.
- A review stage with `on_findings: fix-once` is told to report its findings through the factory's `report_findings` tool. When its run completes having reported some, the task stays at the stage for exactly one fix pass: a run that resumes the session on those findings, told to report through the same tool whatever it leaves unfixed; a fix pass that reports nothing back leaves every finding over. Findings are kept on the task, so a run parked meanwhile loses none, and a fix pass taken over and handed back off is still told what to fix. Once the fix pass completes, the stage's exit is checked as usual and the task moves on, whatever is left: findings never loop. A review that reports none moves on at once.
- A stage whose exit is `artifact:pr-body` is told to write the PR body through the factory's `write_pr_body` tool (each AFK run is given only the factory tools its stage reports through), and the exit holds once it has. The factory adds to the agent's text: a closing keyword (`Closes #n`, `Fixes owner/name#n`, `Resolves` and an issue URL…) on a ticket the task closed becomes `Implements`, so merging doesn't close it again (ADR 0006), each closed ticket the body doesn't already say it implements is listed as `Implements #n`, and the findings the fix pass left over follow under their own heading. The task's PR body is the one artifact that is no issue.
- A `stage-blocked` attention request is raised instead, naming what's missing, when the exit doesn't hold (the factory can't evaluate `map-cleared` there yet, so it never holds; a `tickets-closed` loop moves the task on itself once its tickets are closed or skipped), the next stage's `args` can't be filled, the next stage is HITL (take the task over to start it), or it is a factory action (none runs yet). The task stays at its stage. Answering the request sends its run on at that stage, told what was missing, and the boundary is checked again when that run completes.
- Past the last stage, the root task goes In review and shows in Needs you.

An AFK task's autonomy level changes only between runs, never under a live one, and is clamped to its stage's `autonomy` ceiling. Each run also takes its stage's ceiling.
