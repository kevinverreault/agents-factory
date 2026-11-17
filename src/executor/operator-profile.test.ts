// Where the operator profile a contained HITL run gets is on the host
// (ADR 0015): what a HITL run on the host, in the daemon's environment,
// would read of the operator's user instructions and the project's auto memory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { operatorProfileOf } from './agent-sdk.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A CLI config directory with the operator's user `settings`, if any, and an environment naming it.
function configWith(settings?: string): NodeJS.ProcessEnv {
  const config = mkdtempSync(join(tmpdir(), 'factory-profile-'));
  dirs.push(config);
  if (settings !== undefined) writeFileSync(join(config, 'settings.json'), settings);
  return { CLAUDE_CONFIG_DIR: config };
}

const root = join(tmpdir(), 'clones', 'widgets');

test('is the user CLAUDE.md in the CLI’s config directory, and the auto memory of the repository’s project directory', () => {
  const env = configWith();

  expect(operatorProfileOf(root, env)).toEqual({
    claudeMd: join(env.CLAUDE_CONFIG_DIR!, 'CLAUDE.md'),
    memory: join(env.CLAUDE_CONFIG_DIR!, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'),
  });
});

test('has no auto memory when the operator turned it off, in the environment or their user settings', () => {
  expect(operatorProfileOf(root, { ...configWith(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }).memory).toBeNull();
  expect(operatorProfileOf(root, { ...configWith(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: 'true' }).memory).toBeNull();
  expect(operatorProfileOf(root, configWith('{ "autoMemoryEnabled": false }')).memory).toBeNull();
  expect(operatorProfileOf(root, { ...configWith(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }).memory).not.toBeNull();
});

test('follows the auto memory directory the operator’s user settings name, when it is absolute', () => {
  const absolute = join(tmpdir(), 'my-memory');

  expect(operatorProfileOf(root, configWith(JSON.stringify({ autoMemoryDirectory: absolute }))).memory).toBe(absolute);
  expect(operatorProfileOf(root, configWith('{ "autoMemoryDirectory": "~/notes/memory" }')).memory).toBe(`${homedir()}/notes/memory`);
  // One the CLI ignores falls back to the project's, as it does.
  expect(operatorProfileOf(root, configWith('{ "autoMemoryDirectory": "notes" }')).memory).toMatch(/[\\/]memory$/);
});

test('reads settings it can’t parse as none, as the CLI would', () => {
  expect(operatorProfileOf(root, configWith('{ not json')).memory).toMatch(/[\\/]memory$/);
});
