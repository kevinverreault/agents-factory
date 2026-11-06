---
status: accepted
---

# The operator steers wayfinder's work loop, and a cleared map may stop short

Wayfinder's `work` stage is a HITL `loop` whose exit is `map-cleared`: a **work loop** over a **map**. Unlike the **Ralph loop**, where the factory picks each ticket and judges and closes it (ADR 0006), the work loop leaves both choices to the **operator** and the skill. The factory reads the map and offers its **frontier**. The operator picks the next ticket or takes the first. The wayfinder skill resolves and closes the ticket in the conversation. We chose this because a map's tickets are decisions worked *with* the operator, one per session, and which decision to take next is exactly the steering a HITL loop is for. Decided in [Wayfinder work loop](https://github.com/kevinverreault/agents-factory/issues/56) (stories 38 and 40 of [#23](https://github.com/kevinverreault/agents-factory/issues/23)).

## Decisions

- **The factory reads, the operator picks.** Entering the work loop starts no run. The daemon reads the map's sub-issues with a read-only App token, and the task shows Ready for you with the frontier under it: the open tickets with no open blockers, in sub-issue order. A digit picks a ticket, and opening the task takes the first. Each ticket is one fresh HITL session on `/factory:wayfinder <map> <ticket>`, holding no slot.
- **The skill closes tickets, not the factory.** HITL work acts as the operator (ADR 0004), so the conversation resolves and closes its ticket through the operator's own `gh` login. Confirming the advance sheet finishes the ticket's run, and the factory reads the map again. The factory never closes, comments on or reopens a map's tickets, so the cancel cascade (ADR 0006) has none to reopen.
- **`map-cleared` holds once the map has no open ticket.** It is evaluated on the factory's read of the map, never on a run's completion. A map whose every open ticket is blocked raises a `stage-blocked` request, and answering it reads the map again.
- **A cleared map may stop short of the spec.** Once it clears, the operator chooses where the task goes: continue to the next stage, jump over it to the one after, or end the task (In review). A jump may skip that one stage even though it isn't `optional`. The map then stands in for the artifact the skipped stage would have made: wayfinder's tickets are written from the map when the spec is jumped over. The stage jumped to starts fresh when the one jumped over would have (`context: fresh`).

## Considered options

- **The factory picks the first frontier ticket, as in the Ralph loop.** Rejected: the operator works each ticket with the agent, so which decision comes next is theirs. Taking the first stays one key away.
- **The factory closes the ticket when the operator finishes it.** Rejected: the decision's resolution comment is the skill's to write. Closing as the App would also make HITL work write as the bot (ADR 0004).
- **Always continue to spec.** Rejected: some maps' destination is the decision itself, and others already say enough to write tickets.

## Consequences

- Finishing a ticket the conversation didn't close brings it back on the next frontier, with no warning yet.
- The frontier doesn't leave out claimed (assigned) tickets, though the wayfinder skill's does. A ticket the operator's own parked session claimed would otherwise vanish from it.
- Research tickets on the map are worked like any other until the AFK research children of [#57](https://github.com/kevinverreault/agents-factory/issues/57) arrive.
