---
name: gate-check
description: Judge whether a semi-auto PR whose checks are green can merge without the operator, or should go to them for review. Use when the factory's gate check hands you a PR, its ticket and spec, the review findings left over and the operator's rubric.
---

The factory merges this PR into the base branch on your verdict alone, with no human reading it first. Your job is to catch the PRs the operator would want to see, not to review the code again: the review stage already did, and its findings left over are in your opening.

1. **Read what the PR was for.** The ticket and its spec, with `gh issue view`, or the brief in your opening when there is no ticket. Note its done-when.
2. **Read the whole diff**, with the command your opening gives. Read the files around a change when the diff alone doesn't say what it does.
3. **Weigh it against the rubric** in your opening, line by line, and against the findings left over. A line that holds, or that you can't rule out, is a reason to ask. Under the rubric's lines, ask too when the PR does something its ticket and spec don't account for.
4. **Report your verdict** through `report_verdict`, once: `merge` when no rubric line holds, with a sentence saying why it is safe to merge; `ask` otherwise, naming the rubric line and where in the diff it holds. The operator reads the reason either way: as the reason the task waits for them, or as a judgement call once it merged.

When in doubt, ask: a PR the operator didn't need to see costs them a minute, a bad merge costs far more. Change nothing: don't edit, commit or push, and don't comment on GitHub. End your run once you reported.
