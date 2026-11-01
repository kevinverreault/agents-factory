// An AFK run's own `GH_CONFIG_DIR` (ADR 0004): the read-only bot token, as
// `gh` reads it on every call, so a token the daemon rewrites mid-run takes
// effect at the run's next `gh`. The files are read-only to the run; only
// the daemon rewrites them.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Writes (or rewrites) the token into `dir`, and returns the environment
// variables that point `gh` at it, with its prompts and update checks off.
export function writeRunGh(dir: string, user: string, token: string): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  // `version: 1` says the hosts file is in the layout `gh` migrates to, so it never rewrites it.
  writeReadOnly(join(dir, 'config.yml'), 'version: "1"\n');
  writeReadOnly(
    join(dir, 'hosts.yml'),
    [
      'github.com:',
      '    users:',
      `        ${user}:`,
      `            oauth_token: ${token}`,
      '    git_protocol: https',
      `    oauth_token: ${token}`,
      `    user: ${user}`,
      '',
    ].join('\n'),
  );
  return { GH_CONFIG_DIR: dir, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
}

function writeReadOnly(path: string, content: string): void {
  if (existsSync(path)) chmodSync(path, 0o644);
  writeFileSync(path, content, { mode: 0o444 });
  chmodSync(path, 0o444);
}
