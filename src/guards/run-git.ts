// The cleaned git environment of an AFK run (ADR 0007): pushes fail inside
// git itself, so a push that slips past the hard denies still can't publish,
// and every commit is the factory identity's, with the run's trailers (ADR
// 0004). The run's gitconfig and hooks live in a directory of its own, which
// the daemon removes once the run is checked.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Who AFK commits are authored and committed by.
export type FactoryIdentity = { name: string; email: string };

// Until the factory's GitHub App exists, its bot under the factory's own name.
export const FACTORY_IDENTITY: FactoryIdentity = {
  name: 'agents-factory[bot]',
  email: 'agents-factory[bot]@users.noreply.github.com',
};

// What every AFK commit names.
export type CommitTrailers = { task: string; run: string; model: string };

// Removed from an AFK run's environment: the operator's GitHub and SSH
// credentials, and an API key that would win over the subscription login.
export const AFK_UNSET = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'] as const;

// The URL scheme every push is rewritten to: git has no helper for it, and
// says so with the scheme's name.
const NO_PUSH = 'the-factory-pushes-for-you://';

// The hooks git runs, every one of which hands over to the repository's own.
const HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'reference-transaction',
  'pre-auto-gc',
  'post-index-change',
  'fsmonitor-watchman',
  'sendemail-validate',
];

// Writes the run's gitconfig and hooks into `dir`, and returns the
// environment variables that point git at them.
export function prepareRunGit(dir: string, identity: FactoryIdentity, trailers: CommitTrailers): Record<string, string> {
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  const gitconfig = join(dir, 'gitconfig');
  writeFileSync(
    gitconfig,
    [
      '# An AFK run’s global git config, written by the factory (ADR 0007).',
      '[user]',
      `\tname = ${identity.name}`,
      `\temail = ${identity.email}`,
      '[credential]',
      '\thelper =',
      // An empty prefix matches every URL, so no push goes anywhere; fetch is untouched.
      `[url "${NO_PUSH}"]`,
      '\tpushInsteadOf =',
      '',
    ].join('\n'),
  );
  for (const hook of HOOKS) {
    const trailing =
      hook === 'prepare-commit-msg'
        ? [
            `git interpret-trailers --in-place --if-exists replace ${[
              `Factory-Task: ${trailers.task}`,
              `Factory-Run: ${trailers.run}`,
              `Model: ${trailers.model}`,
            ]
              .map((trailer) => `--trailer ${shellQuoted(trailer)}`)
              .join(' ')} "$1"`,
          ]
        : [];
    writeFileSync(
      join(hooks, hook),
      [
        '#!/bin/sh',
        '# An AFK run’s hook, written by the factory: the repository’s own runs first.',
        'own=$(git config --local core.hooksPath) || own="$(git rev-parse --git-common-dir)/hooks"',
        `if [ -x "$own/${hook}" ]; then "$own/${hook}" "$@" || exit $?; fi`,
        ...trailing,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    // Command-scope settings beat the repository's own config: its hooks
    // path, credential helpers and identity can't take the run's place. Every
    // ref the run updates, tags too, is logged under its identity, by which
    // the check after it tells the run's refs from the operator's.
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'core.logAllRefUpdates',
    GIT_CONFIG_VALUE_2: 'always',
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'false',
  };
}

// The text as one word for `sh`.
function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
