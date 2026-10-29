# The factory's own skills

Each directory here holding a `SKILL.md` is a skill the factory layers on top of the pinned upstream library in the `factory` plugin (ADR 0005). A factory skill never reuses an upstream skill's name: building the skill set refuses one that does. Factory behaviour such as closing tickets or opening PRs stays in `action` stages, never in skill text.
