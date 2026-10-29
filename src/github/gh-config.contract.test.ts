// Seam 3: `gh` re-reads `hosts.yml` on every call, so the read-only bot token
// the daemon refreshes in a run's GH_CONFIG_DIR takes effect mid-run (ADR 0004).
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

function runConfigDir(): { dir: string; writeToken(token: string): void } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-gh-'));
  return {
    dir,
    writeToken(token) {
      writeFileSync(join(dir, 'hosts.yml'), `github.com:\n    oauth_token: ${token}\n    user: factory-bot\n    git_protocol: https\n`);
    },
  };
}

// The run environment: the operator's login removed, the bot's config dir set.
function gh(configDir: string, args: string[]) {
  const { GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, ...env } = process.env;
  return execFileAsync('gh', args, { env: { ...env, GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: '1' } }).then(
    ({ stdout }) => ({ ok: true, output: stdout.trim() }),
    (error: { stdout: string; stderr: string }) => ({ ok: false, output: `${error.stdout}${error.stderr}`.trim() }),
  );
}

describe('gh with a factory-managed GH_CONFIG_DIR', () => {
  test('a token refreshed in hosts.yml is used by the next gh call', async () => {
    const config = runConfigDir();
    config.writeToken('ghs_skeletonFirstToken');
    expect(await gh(config.dir, ['auth', 'token'])).toEqual({ ok: true, output: 'ghs_skeletonFirstToken' });

    config.writeToken('ghs_skeletonRefreshedToken');
    expect(await gh(config.dir, ['auth', 'token'])).toEqual({ ok: true, output: 'ghs_skeletonRefreshedToken' });
  });

  test('API calls send the token from hosts.yml, never the operator login', async () => {
    const config = runConfigDir();
    config.writeToken('ghs_skeletonRevokedToken');

    const call = await gh(config.dir, ['api', 'user']);

    expect(call.ok).toBe(false);
    expect(call.output).toMatch(/Bad credentials|HTTP 401/);
  });
});
