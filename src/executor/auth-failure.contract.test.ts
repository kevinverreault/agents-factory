// Seam 3: a run whose login Claude Code can't sign in with. Runs the bundled
// CLI through the executor with a config dir whose stored login has expired
// and lost its refresh token, as a login another process used up leaves it:
// the CLI fails before any request, so the test spends no usage.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { waitFor } from '../os/test-support.ts';
import { agentSdkExecutor } from './agent-sdk.ts';
import type { ConversationEvent, RunStart } from './executor.ts';
import { afkRun } from './sdk-test-support.ts';

let saved: NodeJS.ProcessEnv;

// The executor builds a host run's environment from the daemon's: point it
// at the expired login, with no other credential to fall back on.
beforeEach(() => {
  saved = { ...process.env };
  const config = mkdtempSync(join(tmpdir(), 'factory-auth-'));
  const expired = { accessToken: '', refreshToken: '', expiresAt: 0, scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'] };
  writeFileSync(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: expired }));
  for (const name of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH$)/.test(name)) delete process.env[name];
  }
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
});

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

const SIGN_IN_AGAIN = '`claude auth login`';

test('a HITL turn Claude Code can’t sign in for tells the operator how to sign in again', async () => {
  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];
  const live: ConversationEvent[] = [];
  const run: RunStart = {
    ...afkRun(mkdtempSync(join(tmpdir(), 'factory-auth-hitl-')), 'Say hello.', 1),
    mode: 'HITL',
    autonomy: null,
    maxTurns: null,
    guards: null,
    allowRules: [],
  };

  executor.start(run, { report: (event) => reported.push(event), converse: (event) => live.push(event), askPermission: () => {} });
  try {
    await waitFor(() => reported.some((event) => event.type === 'turnEnded' || event.type === 'runFailed'), 60_000);
  } finally {
    executor.stop('R1');
  }

  const said = live.flatMap((event) => (event.type === 'message' && event.from === 'agent' ? [event.text] : []));
  expect(said).toEqual([expect.stringMatching(/^Failed to authenticate/)]);
  expect(said[0]).toContain(SIGN_IN_AGAIN);
});

test('an AFK run Claude Code can’t sign in for fails with how to sign in again', async () => {
  const executor = agentSdkExecutor();
  const reported: RunEvent[] = [];

  executor.start(afkRun(mkdtempSync(join(tmpdir(), 'factory-auth-afk-')), 'Say hello.', 1), { report: (event) => reported.push(event), converse: () => {}, askPermission: () => {} });
  await waitFor(() => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed'), 60_000);

  const failed = reported.find((event) => event.type === 'runFailed');
  expect(failed).toMatchObject({ reason: expect.stringMatching(/^Failed to authenticate/) });
  expect(failed).toMatchObject({ reason: expect.stringContaining(SIGN_IN_AGAIN) });
});
