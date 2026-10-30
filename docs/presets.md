# Workflow presets

A **workflow preset** is the sequence of **stages** a task follows. A task freezes its preset when it launches: editing a preset file later never changes a task already in flight. The decisions behind the format are in [#12](https://github.com/kevinverreault/agents-factory/issues/12), amended by ADR 0008 (`max_turns`, no `budget`).

## Where presets live

A preset is a YAML file named `<name>.preset.yaml`, in one of three scopes:

| Scope | Where | Read |
|---|---|---|
| Built-in | `src/presets/built-in/` | Shipped with the factory: `main-flow`, `wayfinder`, `quick`, `child`, `setup` |
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
| `max_turns` | A whole number of at least 1, the runaway guard |
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

A preset that `extends` another takes its stages, overrides single ones by `id` field by field, and inserts each new stage before the next one it overrides (or last, after them all). `from: <stage id>` takes the extended preset's stages from that stage onward only: `wayfinder` extends `main-flow` from `spec`. A preset extending its own name extends the one it shadows in a lower scope, so a repo can tweak the built-in `main-flow` by one stage. Other presets extending `main-flow` then extend that tweak.

The resolved stages are checked whole against the schema at launch. A preset that fails, names an unknown exit condition or template, or extends one that is missing or itself is refused with the reason.

## Starting at a stage

The launch card's start stage picker offers the stages whose `args` the launch inputs can fill: the prompt fills `{{prompt}}`, and issue refs stand for the issue artifacts (`map`, `spec`, `tickets`) earlier stages would have made. The first stage is offered even when it needs no input (`setup`); a later stage that needs none isn't, since it works from what earlier stages left. A stage needing an artifact no launch input stands for (`pr-body`) is never offered. Starting `main-flow` at `implement` with issue refs makes the task AFK from its first run, at L1. Until the Ralph loop arrives, that first run gets every ref at once rather than one ticket per iteration (ADR 0006).
