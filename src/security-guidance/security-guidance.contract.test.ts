// Seam 3: the security guidance plugin's hook, run as Claude Code runs it,
// with the Python and bash on the operator's machine and no Claude at all.
// AFK runs get its pattern warnings only: the hook warns about an edit that
// writes a dangerous pattern, and never reaches for a model.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SECURITY_PLUGIN } from './security-guidance.ts';

type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };

const hooks = (): Record<string, HookEntry[]> => JSON.parse(readFileSync(join(SECURITY_PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;

// Runs the plugin's edit hook on `input` as Claude Code would: its command,
// in a shell, with the plugin's root filled in. The environment carries no
// credentials, and the hook keeps its state in a directory of its own.
function runEditHook(input: object): { stdout: string; stateDir: string } {
  const [entry] = hooks().PostToolUse!;
  const command = entry!.hooks[0]!.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', SECURITY_PLUGIN);
  const stateDir = mkdtempSync(join(tmpdir(), 'factory-security-state-'));
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ...env } = process.env;
  const result = spawnSync('bash', ['-c', command], {
    input: JSON.stringify(input),
    env: { ...env, SECURITY_WARNINGS_STATE_DIR: stateDir },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return { stdout: result.stdout, stateDir };
}

// A project to edit in: a git repo, since the hook only tells a run about
// reviews that can't run for edits inside one.
function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-security-project-'));
  expect(spawnSync('git', ['init', '--quiet', dir]).status).toBe(0);
  return dir;
}

const execWrite = (dir: string) => ({
  session_id: 'S1',
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(dir, 'list.js'), content: "const { exec } = require('child_process');\nexec(`ls ${process.argv[2]}`);\n" },
  tool_response: { type: 'create' },
  cwd: dir,
});

describe('security guidance plugin', () => {
  test('hooks only edits: no review at session start, prompt, commit, push or stop', () => {
    expect(Object.keys(hooks())).toEqual(['PostToolUse']);
    expect(hooks().PostToolUse!.map((entry) => entry.matcher)).toEqual(['Edit|Write|MultiEdit|NotebookEdit']);
  });

  test('warns about an edit that writes child_process.exec, and reaches for no model', () => {
    const dir = projectDir();
    const { stdout, stateDir } = runEditHook(execWrite(dir));

    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('command injection') });
    // With the reviews on and no credentials, the hook would say they can't run.
    expect(output.systemMessage).toBeUndefined();
    // Nor does it start installing the Python Agent SDK the reviews need.
    // (Where that SDK is already importable, it wouldn't anyway.)
    expect(existsSync(join(stateDir, '.sdk_bootstrap_spawned'))).toBe(false);
  });

  test('says nothing about an edit that writes no dangerous pattern', () => {
    const dir = projectDir();
    const { stdout } = runEditHook({ ...execWrite(dir), tool_input: { file_path: join(dir, 'sum.js'), content: 'export const sum = (a, b) => a + b;\n' } });

    expect(stdout.trim()).toBe('');
  });
});
