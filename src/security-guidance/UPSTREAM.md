# Vendored: security-guidance

`plugin/hooks/*.py`, `plugin/hooks/sg-python.sh` and `plugin/LICENSE` are byte for byte the files of Anthropic's `security-guidance` plugin, version 2.0.19, from [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/43fd1f9db0941b2b83cb62268e35970d4a67c202/plugins/security-guidance) at `43fd1f9db0941b2b83cb62268e35970d4a67c202`, under the Apache License 2.0 in `plugin/LICENSE`. Upstream's tests and README aren't vendored.

The factory's own files are:

- `plugin/.claude-plugin/plugin.json`, which names the plugin `factory-security`.
- `plugin/hooks/hooks.json`, which wires only upstream's PostToolUse hook on edits. Upstream's SessionStart (installs the Python Agent SDK), UserPromptSubmit (records a git baseline for the reviews), Bash commit and push (the agentic commit review) and Stop (the diff review) hooks are left out.
- `plugin/hooks/pattern-only.sh`, which runs upstream's launcher with `ENABLE_CODE_SECURITY_REVIEW=0`.

## Moving the pin

1. Copy the new revision's `plugins/security-guidance/hooks/*.py`, `hooks/sg-python.sh` and `LICENSE` over these, with no line-ending conversion (check out with `core.autocrlf=false`).
2. Read upstream's new `hooks/hooks.json` and `security_reminder_hook.py`'s `main()` for new events or switches, and check that `ENABLE_CODE_SECURITY_REVIEW=0` still turns every model call off.
3. Update the revision and version above, and run `src/security-guidance/security-guidance.contract.test.ts`.
