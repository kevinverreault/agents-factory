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
    kind: tickets
    skill: implement
    args: "{{artifacts.tickets}}"
    mode: AFK
    model: sonnet
    exit: spec-closed
```

Preset fields: `description`, `stages`, `limits`, and `extends` + `from` (below). Anything else is refused.

`limits` lowers the brakes on the task trees launched with the preset (ADR 0009): `depth` (at most 2: root → child → grandchild), `children` (at most 5 spawned by one task over its life) and `descendants` (at most 12 under one root). Each is optional and can only go down; a preset extending another overrides its limits one by one. A child task runs the built-in `child` preset, and spawns under its root's limits.

Stage fields:

| Field | Values |
|---|---|
| `id` | Lowercase letters, digits and dashes, unique in the preset |
| `kind` | `run` (one agent run of a skill), `loop` (the HITL work loop over a map: `mode: HITL` with exit `map-cleared`, ADR 0012), `tickets` (launches a ticket task per frontier ticket, ADR 0013) or `action` (a factory step with no agent) |
| `skill` | A skill of the skill set, invoked as `/factory:<skill>`. A `loop` and a `tickets` stage need one (a `tickets` stage's is what each ticket task's first run invokes on its ticket); a `run` without one sends its `args` as they are; an `action` has none |
| `args` | A template: `{{prompt}}` and `{{artifacts.<kind>}}`, with kinds `map`, `spec`, `tickets`, `pr-body` |
| `mode` | `HITL` or `AFK` |
| `model` | A model tier: `opus`, `sonnet` or `haiku` |
| `autonomy` | `L1`, `L2` or `L3`, the ceiling an AFK stage may run at. HITL stages have none |
| `max_turns` | A whole number of at least 1, the runaway guard of an AFK stage's runs: hitting it ends the run `failed` with a failure attention request. Without it a run gets the global default of 300; the launch card's max turns overrides both |
| `context` | `resume` (the default) or `fresh` |
| `optional` | `true` when the advance sheet may skip it |
| `exit` | `run-completed`, `artifact:<kind>`, `map-cleared` or `spec-closed` (holds once a spec task's spec is closed; a ticket task's run on the stage ends it). A HITL stage without one advances when the operator confirms. The Ralph loop's `tickets-closed` is retired and refused |
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

A preset that `extends` another takes its stages, overrides single ones by `id` field by field, and inserts each new stage before the next one it overrides (or last, after them all). `from: <stage id>` takes the extended preset's stages from that stage onward only: `wayfinder` extends `main-flow` from `spec`, and `implement` extends `main-flow` from `implement`, launching ticket tasks on issue refs, or one run on a prompt. A preset extending its own name extends the one it shadows in a lower scope, so a repo can tweak the built-in `main-flow` by one stage. Other presets extending `main-flow` then extend that tweak.

The resolved stages are checked whole against the schema at launch. A preset that fails, names an unknown exit condition or template, or extends one that is missing or itself is refused with the reason.

## Starting at a stage

The launch card's start stage picker offers the stages whose `args` the launch inputs can fill: the prompt fills `{{prompt}}`, and issue refs stand for the issue artifacts (`map`, `spec`, `tickets`) earlier stages would have made. The first stage is offered even when it needs no input (`setup`); a later stage that needs none isn't, since it works from what earlier stages left. A stage needing an artifact no launch input stands for (`pr-body`) is never offered. Starting `main-flow` at `implement` with issue refs makes the task AFK from its first run, at L1: a spec task that launches a ticket task per ticket, or itself a ticket task when the one ref has no sub-issues (ADR 0013).

A stage whose `args` name both `{{prompt}}` and an issue artifact takes either: any one launch input fills it, and the other fills as empty, where every other stage needs all the variables of its `args`. `implement` is such a stage (`{{artifacts.tickets}} {{prompt}}`). Issue refs launch ticket tasks over their tickets (below); a prompt alone is a single run; with both, the refs set the tickets and each ticket task's first message also gets the prompt as operator instructions. An issue number typed in the prompt is not read as a ref: it reaches the skill as text. The rule holds at stage boundaries too: a task reaching such a stage with a prompt but no artifact (or the reverse) opens it on what it has, rather than raising `stage-blocked`; one with neither is blocked as usual.

## Artifacts of a kind

`artifact:<kind>` and `{{artifacts.<kind>}}` name the task's artifacts of that kind. An issue is one of kind `spec` (or `map`, `tickets`) when it was captured during a stage whose exit is `artifact:spec`, so an issue the grill merely printed is no spec. In `args` they read as `owner/name#n`, separated by spaces. A task started past the stages that make them reads its launch issue refs instead, for the kinds its start stage's `args` name. Exits count only captured artifacts.

## Moving from stage to stage

**HITL → HITL.** The agent may call `propose_advance` on the factory MCP server. The proposal shows as a banner in the conversation and changes nothing else; the operator's next message sets it aside. Only the operator advances, on the advance sheet (`ctrl+n`), which lists the HITL stages up to the next AFK one and skips optional ones with `space`. Confirming:

- is refused while the stage's exit doesn't hold. `run-completed` holds, since confirming ends the run completed; `artifact:<kind>` holds once the task has an artifact of that kind. `map-cleared` holds once the work loop's map has no open ticket (below).
- is refused when the next stage is AFK: the handoff starts that one.
- otherwise ends the stage's run `completed` and starts a run of the next stage, its skill invoked on its filled `args`. It resumes the session, or starts a new one with `context: fresh`, at the tier the operator picked at launch, else the stage's model tier (the task's when the stage names none).
- raises a `stage-blocked` attention request instead, naming what's missing, when the next stage's `args` can't be filled. The run still ends, and the task stays at the stage it was leaving, to advance from again once the request is answered.
- past the last stage, puts the root task in review.

**The work loop.** A HITL `loop` stage whose exit is `map-cleared` (wayfinder's `work`) works its map with the operator, one ticket per session (ADR 0012). Entering it starts no run: the factory reads the map's sub-issues from GitHub, and the task shows Ready for you with the map's frontier under it (the open tickets with no open blockers, in sub-issue order), while it reads "Reading the map". A digit on its sheet picks a ticket, and opening the task takes the first: either starts a fresh session on the stage's skill, its `args` and the ticket (`/factory:wayfinder <map> <ticket>`). Confirming the advance sheet on that ticket's run finishes it: the run ends `completed` and the factory reads the map again. Every open ticket blocked raises a `stage-blocked` request, and answering it reads the map again. Once the map has no open ticket, `map-cleared` holds, and the operator chooses on the task's sheet where it goes: continue to the next stage (`spec`), jump over it to the one after (`tickets`, its `{{artifacts.spec}}` filled with the map), or end, which puts the root In review and closes the map as the factory's App. Once the spec is jumped over, the map is the handoff's spec candidate: its open sub-issues, the tickets written from it, are the ticket set, its closed decision tickets are ignored, and it closes with its last ticket. The factory never closes, comments on or reopens a map's decision tickets.

**Quick launch.** `n` takes one prompt and launches the `quick` preset (as the repository resolves it) as a quick launch, which its start stage must be HITL for. Its grill, the factory's `quick-grill` skill, shows its questions on a small card over the screens rather than in the conversation view, and asks at most three: a card asking past them is cut to the ones left. The factory opens the handoff sheet itself, at L1 as always, once the grill is done: a turn of it ended on the operator's (so the agent has read every answer), or it asked past its three questions, which opens the sheet in place of that card, interrupting the agent. A grill resumed after a restart is done only once a turn of it ends. Opening the sheet ends the quick launch: backing out of it carries on in the conversation view. `ctrl+e` ends it too, expanding the card into the full conversation on the same session, where it is a grill like any other, and `esc` leaves it as one. `ctrl+h` (or `/handoff`) opens the sheet at any question. `esc` while the launch is still being named leaves too: once launched, the grill carries on as an ordinary conversation, as after any `esc`. Confirmed, the handoff runs `quick`'s implement stage as a single AFK run on the brief, then the review and PR body; at L1 open-pr is skipped as below.

**HITL → AFK.** The agent may call `propose_handoff`, shown as a banner that changes nothing else. Only the operator hands off, from any HITL stage, with `/handoff` (or `ctrl+h`, where the terminal tells it from Backspace). That interrupts an agent mid-turn, drops an open question card and any queued messages, and opens the handoff sheet. The HITL run writes the handoff brief (goal, decided, done when, out of scope, links) through `write_handoff_brief` as its last turn, and a task with no live run first resumes its session just for that. The sheet hands off to the first AFK stage from the task's own stage on, skipping the remaining HITL stages, and pre-fills its fields from that stage: continue-as (resume, or fresh from the brief once the conversation fills more than 60% of the context window), autonomy (L1 unless the operator picks L2, whose runs execute in the task's own container, or L3, which runs as L2 and lets the factory merge the task's PR), tier and max turns. It also shows the ticket set the handoff will launch, read from GitHub's sub-issues of the issues the task recorded at any stage ("Spec #132 → 5 tickets, 2 ready now"), with the tickets held back by their label, and the operator can correct it: `space` selects a spec candidate (the one recorded last starts selected), alone since a spec task works one spec, or deselects it, such as an issue the run only read. A recorded issue whose tickets are linked only by text ("Part of #n") shows with 0 tickets. With no ticket set, it says the handoff is one run on the brief. `esc` backs out and the conversation carries on. Confirming:

- is refused until the agent has written the brief, and blocked while the task branch isn't checked out, the worktree has changes to files that are no artifact of the task, or a remote has a `pushurl`.
- commits the task's uncommitted artifacts (its glossary and ADR edits) to the task branch, under the operator's identity, as the HITL work they are.
- ends the HITL run `handed off` and queues the AFK stage's run. Its first message is the stage's skill, then the edited brief, which also becomes the task's goal of record. Args an early handoff skipped the stages for are left out, and the brief stands in for them. Fresh from the brief starts a new session.
- with no AFK stage ahead (or no preset), queues one AFK run on the brief, after which the root task goes In review.

**AFK → AFK.** No one confirms: when an AFK stage's run completes, the factory checks the boundary itself.

- When the stage's exit holds, the task moves to the next stage and queues its run, the skill invoked on its filled `args`, resuming the session or starting a new one with `context: fresh`. It queues as work continuing something in flight, so the scheduler gives it a slot after urgent work and before work not yet started.
- A stage that `requires: L2` runs at L2 or above and is skipped below, so at L1 `open-pr` is, and the root reaches In review with its task branch only on the operator's machine.
- A review stage with `on_findings: fix-once` is told to report its findings through the factory's `report_findings` tool. When its run completes having reported some, the task stays at the stage for exactly one fix pass: a run that resumes the session on those findings, told to report through the same tool whatever it leaves unfixed; a fix pass that reports nothing back leaves every finding over. Findings are kept on the task, so a run parked meanwhile loses none, and a fix pass taken over and handed back off is still told what to fix. Once the fix pass completes, the stage's exit is checked as usual and the task moves on, whatever is left: findings never loop. A review that reports none moves on at once.
- A stage whose exit is `artifact:pr-body` is told to write the PR body through the factory's `write_pr_body` tool (each AFK run is given only the factory tools its stage reports through), and the exit holds once it has. The factory adds to the agent's text: a ticket task's body says `Closes #n` for its ticket, so merging closes it (ADR 0013), and the findings the fix pass left over follow under their own heading. The task's PR body is the one artifact that is no issue.
- A `stage-blocked` attention request is raised instead, naming what's missing, when the exit doesn't hold (the factory can't evaluate `map-cleared` there yet, so it never holds), the next stage's `args` can't be filled, the next stage is HITL (take the task over to start it), or it is a factory action (none runs yet). The task stays at its stage. Answering the request sends its run on at that stage, told what was missing, and the boundary is checked again when that run completes.
- Past the last stage, the root task goes In review and shows in Needs you, or, under full-auto, waits at its merge gate (below).

**Ticket tasks.** A handed-off task with a ticket set becomes a **spec task** (ADR 0013). Its `implement` stage runs nothing itself: it launches one **ticket task** per frontier ticket, in parallel within the slot cap, a ticket being takeable once its blockers are merged. `ready-for-agent` tickets get AFK ticket tasks, `ready-for-human` ones HITL ticket tasks (Ready for you, holding no slot, handed off like any HITL task), and any other label, or none, is held back. When nothing is in flight and only held-back tickets are left, the spec task raises `stage-blocked` naming them, and answering it reads the tickets again. A ticket task is a root task on the spec task's frozen stages from `implement` onward, with the handoff's autonomy, tier, max turns, groups and per-task rules. Its first message is `/factory:implement <ticket>` and a context block (spec, brief, sibling tickets merged or in flight), and its branch is cut from the spec task's branch after merging `origin/<base>`. Each waits at its **merge gate**, which under the operator **merge policy** it reaches In review and the operator passes by merging, and under full-auto the factory passes (below). A merge closes the ticket (the factory closes it if GitHub didn't), the PR poll runs every 2 minutes while a ticket task is In review, and a PR that stops being mergeable gets a run that merges `origin/<base>` in. When the spec's last ticket closes, the factory closes the spec, and the map it was written from, and the spec task is Done. The Ralph loop (ADR 0006) is retired: a preset naming `tickets-closed` is refused at launch, and a task frozen on a `loop` stage with that exit raises `stage-blocked` saying the loop was retired, once it reaches the stage or at the daemon's start if it is already there. Only cancelling it, to relaunch, carries it on: nothing is migrated.

An AFK task's autonomy level changes only between runs, never under a live one, and is clamped to its stage's `autonomy` ceiling. Each run also takes its stage's ceiling.

**L3** (ADR 0014) runs exactly as L2 does: the task's own container, its egress proxy, `bypassPermissions` and the same git guards. On top, the factory may merge the task's PR into the base branch, when its merge policy lets it. A stage's `autonomy: L2` ceiling clamps an L3 task's runs at that stage to L2, which forbids merging there. L3 needs the factory's App to read the PR's checks, so its installation must grant Checks read and Statuses read: where it doesn't, the launch card, the handoff sheet and a level change refuse L3 with the reason and a link to approve them on GitHub (`ctrl+o` on the launch card opens it), and nothing falls back to L2. Under the `operator` merge policy an L3 task ends In review like an L2 task.

**The merge gate and the merge policy** (ADR 0014). Every AFK root task that opens a PR (a single run on a brief, a quick launch, a ticket-less handoff, or a ticket task) waits at its merge gate once past its last stage, and its **merge policy** decides who passes it. The handoff sheet, and the launch card when a task starts AFK, show a **Merge policy** field at L3 alone, defaulting to `operator`. It is frozen onto the task, and a spec task's ticket tasks inherit it. Picking L1 or L2 resets it to `operator`, and the launch and handoff commands refuse any other policy below L3, or on a launch starting at a HITL stage, which picks it at its handoff.

| Policy | The TUI says | Who merges |
|---|---|---|
| `operator` | operator | The task goes In review and the operator merges its PR, as before. |
| `unattended` | full-auto | The factory, once the PR's checks are green, or the repo runs none. |
| `judged` | semi-auto | Not offered yet: the factory can't run its gate check. |

Under full-auto the task shows **At merge gate** instead of In review, and nothing waits in Needs you. The PR poll reads the combined state of the check runs and commit statuses on the PR's head (green, red, pending or none) at once when the task reaches its gate, then every 2 minutes while any task waits there. Pending checks wait. Red ones get one fix run, as a conflict gets an update run: it resumes the task's session, told which checks failed with a link to each one's page on GitHub, and once it ends the factory pushes its commits and the gate waits on the new head's checks. A read that still gives the old red head after that push is GitHub not caught up yet, and waits for the next. Red again after it, the factory raises a `failure` request naming the checks and merges nothing; answering it, for instance once the operator pushed a fix, sends the task back to its gate, which reads the checks afresh. Once a head's checks are found green, even if the merge they let through then fails, a later red one gets a fix run of its own. A repo with no checks counts as such only once two reads of the same head, 2 minutes apart, both find none: right after a push, CI may not have registered its checks yet. Once they are green, or found none twice, and GitHub finds the PR mergeable, the factory marks the draft ready and merges it with a merge commit, only while its head is still the commit it read. Reading the checks, marking it ready and merging each use an installation token of their own, narrowed to the task's repository and to that action's permissions. A PR that conflicts gets an update run, as a ticket task's does. A step GitHub refuses raises a `github-write` request, and answering it reads the gate afresh and tries again. Once merged, the task follows the merged-PR path: its ticket closes (the factory closes it if GitHub didn't), it is Done, and its cleanup runs. Task detail shows the policy, and while the task waits at its gate the checks and the factory's step.
