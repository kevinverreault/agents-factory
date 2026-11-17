---
status: accepted
---

# Planning stages run contained

A HITL run executes on the host, and every call Claude Code doesn't let through itself becomes a **permission card** (ADR 0007). In a grill, spec or tickets stage, the operator should only have to answer questions. Instead they keep watching for cards: T29's grill, spec and tickets asked for reads of the skill set outside the worktree, `mkdir` in the temp folder, `cygpath` and `gh` issue writes. The L1 allow list has been widened again and again to keep up (#89, T9, T10, T32). Rather than keep widening it, we contain these stages: a HITL stage can declare **containment**, and its runs then execute in the task's container under `bypassPermissions`, as L2 runs do. The container, not the allow list, keeps them safe. Every built-in HITL stage is contained (grill, spec, tickets, quick-grill, wayfinder's chart and work loop) except setup, which stays on the host. A task with no contained stages works as before.

## Decisions

- **Containment is a stage property, not an autonomy level.** Mode still says who is at the wheel, and the autonomy level still bounds what happens unattended. HITL tasks still have no level. Every AFK run at L2 and above is contained, as ADR 0007's table says. A HITL stage is contained when its workflow preset says so. A takeover still continues on the host.

- **No tool calls ask.** A contained HITL run raises no permission cards. Questions still reach the operator through `AskUserQuestion` and the conversation.

- **Egress stays allowlisted, and a denied host asks once.** The run goes through the task's egress proxy (ADR 0007). A host it can't reach shows as a **host card** in the conversation: allow for this task, allow always (added to the user file's egress hosts), or deny. That is one card per new host, not one per command. WebSearch runs server-side and needs no host.

- **Issues are written by the factory identity.** This amends ADR 0004. The operator's `gh` login never goes into the container. A run under `bypassPermissions` could do anything with it. Instead the run gets an App token for the task's repository alone, with issues write on top of the usual reads and no contents or pull request write, so the skills' `gh issue create` and sub-issue calls work unchanged. Specs, maps and tickets written in contained stages have the factory as author. Commits stay the operator's: the run's gitconfig names them as author, with no credential.

- **Profile, but nothing executable.** A contained run gets the operator's user `CLAUDE.md` and the project's auto-memory, along with the project settings. It doesn't get their user MCP servers, plugins or hooks.

- **Guarded like L2.** This amends ADR 0007's "HITL runs are not guarded" for contained runs. They get the per-run gitconfig and the hard denies, and the git invariant check runs at each bring-out.

- **The work comes out at advance, handoff and spawn.** Each one brings the container's commits out and fast-forwards the host task branch, so ticket tasks and children are cut from the latest work. The advance and handoff sheets require a clean, committed tree in the container. Host commits come in at each prepare and each turn after a park. True divergence blocks the sheet until the agent merges the host branch in, and a contained run's prepare then leaves the diverged branch for its agent to merge, rather than failing as an AFK run's does, so a parked conversation can still be asked to. Nothing is force-moved. A bring-out is journaled as an intent, the handoff's own or an advance's. This amends ADR 0003 for the advance: recovery brings its work out before reconciling runs, but the advance itself starts the next stage's run, so it is finished just after reconciling, once the dead daemon's run is parked.

- **One container for the task's life.** The same container serves a task's contained HITL stages and its AFK stages (ADR 0011), so `quick` hands off without a bring-out. A handoff to one AFK run at L2 or above leaves the work in the container, unless it commits files on the host, which would move the host task branch past the container's, or makes a spec task, whose ticket tasks are cut from the host task branch: then it brings the work out first. A contained HITL run holds no slot. A live conversation keeps its container running, and a parked run stops it.

- **Bootstrap is budgeted.** The daemon builds the image at startup or upgrade, so a launch never waits for a build. Prepare runs at launch, and the conversation shows it until the first turn. The budget is 15 s cold and 3 s warm, and both are measured.

- **No Docker is an explicit choice, never a silent fallback.** The launch card checks for Docker for any preset with a contained stage. When Docker is unavailable, or prepare fails, the operator can retry or choose "run on host this time", which brings back permission cards for that run.

## Considered options

- **Keep widening the allow list, or give each planning stage its own allow list.** Rejected. Each new skill script or command variant costs another card and another amendment, and T29 shows it never catches up.
- **`bypassPermissions` on the host for planning stages.** Rejected. Nothing would contain it, and L1 on the host only guards against accidents (ADR 0007).
- **The operator's `gh` login in the container.** Rejected. Under `bypassPermissions`, a prompt-injected run could act as the operator anywhere on GitHub.
- **Factory MCP tools that write issues as the operator.** Rejected for now. The upstream skills and each repo's `docs/agents/issue-tracker.md` say "use `gh`", so all of them would need to change.
- **A `gh` shim that forwards write commands to the daemon.** Rejected. Parsing `gh` arguments is fragile and easy to get around.
- **An autonomy level on HITL tasks.** Rejected. For HITL it would only mean "where the run executes", while publishing stays the operator's.

## Consequences

- The default presets now need Docker even for an operator who runs AFK at L1.
- While a stage is live, the operator sees its edits through the conversation, not in their editor, until the next bring-out.
- An App token with issues write is a new, wider token in a container. An injected run could vandalise issues in that one repository while the operator watches.
- Anything outside the repository and the allowed web reaches a contained run only through the scratch folder.
