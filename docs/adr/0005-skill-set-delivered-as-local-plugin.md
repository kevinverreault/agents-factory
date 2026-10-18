---
status: accepted
---

# The factory delivers a pinned skill set to every run as a local plugin

Runs must be reproducible, so the skills a stage invokes can't drift under a task. The upstream Claude Code plugin auto-updates, and personal skills in `~/.claude/skills` override project skills of the same name, so neither the operator's install nor the upstream plugin can be trusted to give a run the same text twice. The research recommended vendoring the skills into each target repo's `.claude/skills/`. That puts upstream files into every repo and every PR, and a personal copy still shadows them. Instead the factory owns one **skill set** outside the target repos and hands it to each run through the Agent SDK's `plugins` option, where skills are namespaced and nothing can shadow them. Decided in [How does the factory provision and pin skills for runs?](https://github.com/kevinverreault/agents-factory/issues/18).

## Decisions

- **What the skill set is.** The whole upstream library (`mattpocock/skills`) at one SHA, not only the skills presets name, since skills call one another. The factory's own skills (such as `quick-grill`) ship in the factory package and are layered on top. They never reuse an upstream name: factory behaviour like closing tickets or opening PRs stays in `action` stages, never in forked skill text.
- **One global pin.** `~/.agent-factory/skills.lock` records the upstream URL and SHA. The factory ships with `mattpocock/skills@49dd158`. No repo-level pin in v1.
- **Built, cached, hashed.** On first need the factory fetches the tarball at the SHA and builds `~/.agent-factory/skills/<hash>/` as a plugin named `factory` (`.claude-plugin/plugin.json` plus `skills/<name>/SKILL.md`). The content hash is the skill set version. A version is kept while any unfinished task references it.
- **Frozen per task.** A task freezes its skill set version at launch, as it does its preset, and every run records the version it saw.
- **Explicit upgrades.** `factory skills update` fetches upstream, shows the commits and changed skills since the pin, and bumps the lock on confirmation. Only new tasks pick it up. Nothing polls or auto-updates.
- **Invocation.** Preset `skill:` values stay bare (`implement`). The factory prompts `/factory:implement <args>`, so a personal or project skill with the same name can't win.
- **What each mode loads.**
  - AFK runs: `settingSources: ['project']`, the plugin, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. That excludes personal skills, user `CLAUDE.md`, user hooks and settings, `settings.local.json` and auto memory.
  - HITL runs: all setting sources plus the plugin, because they act as the operator.
  - The target repo's committed `.claude/skills/` load in both, versioned with the commit the task branched from.
- **L2 containers.** At container creation the factory `docker cp`s the cached `<hash>` directory to `/opt/agent-factory/skills/<hash>`, root-owned and read-only, and passes that path to the SDK. A container reused after a requeue is checked against the task's hash first.
- **The operator's personal install is left alone.** `factory skills status` shows whether personal copies exist and how they differ from the pin.

## Considered options

- **Vendor into each target repo's `.claude/skills/`** (the research's option A). Rejected: upstream files land in every task's diff and PR, and personal skills still override them.
- **`CLAUDE_CONFIG_DIR` pointing at a factory-owned home.** Rejected: it's unverified whether `skills/` moves with it, and it also moves credentials, history and memory, which breaks HITL runs acting as the operator.
- **The upstream Claude Code plugin.** Rejected: it auto-updates and can't be pinned.

## Consequences

- The Windows walking skeleton (ADR 0001) gains three checks:
  - a factory-built plugin directory loads,
  - `/factory:<skill> args` dispatches as an SDK prompt,
  - cross-skill calls inside the set resolve (wayfinder calls `research`, which is `factory:research` in the plugin).
  If namespacing breaks them, the fallback is copying the skill set into the worktree's `.claude/skills/`, kept out of commits through `.git/info/exclude`. In AFK that fallback is still safe, because no personal scope loads.
- In HITL runs a cross-skill call may land on the operator's personal copy instead of the pinned one. That's accepted: HITL is the operator.
- Org-managed skills load regardless of `settingSources`. With one operator on their own machine that is ignored.
