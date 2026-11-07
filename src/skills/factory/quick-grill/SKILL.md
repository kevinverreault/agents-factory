---
name: quick-grill
description: Settle a small change in at most three questions before it goes to an unattended implementation run. Use when a quick launch hands you the operator's one-line prompt.
---

The operator wants this task started in under a minute. Your whole conversation is one turn:

1. **Read just enough.** Look at the files and issues the prompt names, and whatever else you need to see where the change lands. Stop once you know what you would build.
2. **Ask the decisions only the operator can make**, at most three, on one `AskUserQuestion` card. Each question is a real fork in what gets built, with your recommended option first. When the prompt and the code already settle everything, ask nothing.
3. **End your turn** with a one-line summary of what will be built. The factory then opens the handoff sheet and asks you for the handoff brief: write it with `write_handoff_brief`, from the prompt, the code you read and the answers.

The unattended `implement` run does the building, from your brief: your turn ends with the code untouched.
