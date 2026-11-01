// The hard denies (ADR 0007): what an AFK run's PreToolUse hook refuses at
// every level, with a message saying the factory pushes. The run's history is
// a fake: a chain of commits, the run having started at `S`.
import { describe, expect, test } from 'vitest';
import { refusal, type RunHistory } from './hard-denies.ts';

// A--B--S--R1--R2 on the task branch, the run having started at S, and
// `main` behind it at B. Every other name is a path.
const chain = ['A', 'B', 'S', 'R1', 'R2'];
const revs: Record<string, string> = { A: 'A', B: 'B', S: 'S', R1: 'R1', R2: 'R2', HEAD: 'R2', 'HEAD~1': 'R1', 'HEAD~2': 'S', 'HEAD~3': 'B', main: 'B' };
const history: RunHistory = {
  async isCommit(rev) {
    return rev in revs;
  },
  async keepsStart(rev) {
    return rev in revs && chain.indexOf(revs[rev]!) >= chain.indexOf('S');
  },
};

const bash = (command: string) => refusal({ tool: 'Bash', input: { command } }, history);

describe('pushing', () => {
  test('`git push` is refused with the factory-pushes message', async () => {
    expect(await bash('git push origin factory/T1-fix-login')).toBe(
      '`git push` is refused in an AFK run: the factory pushes for you, from the task branch as you leave it. Commit your work there and end the run.',
    );
  });

  test.each([
    'git push',
    'git -C . push',
    'git -c credential.helper= push --force origin HEAD:main',
    '/usr/bin/git push',
    'git.exe push',
    'npm test && git push',
    'cd src; git push',
    'GIT_TRACE=1 git push',
    'env GIT_TRACE=1 git push',
    'bash -c "git push origin main"',
    "sh -c 'cd .. && git push'",
    'echo $(git push)',
    'echo `git push`',
    'git send-pack origin main',
  ])('`%s` is refused', async (command) => {
    expect(await bash(command)).toMatch(/the factory pushes for you/);
  });

  test.each(['git status', 'git log --grep push', 'git commit -m "push the fix"', 'echo "git push"', 'npm run push-docs'])(
    '`%s` runs',
    async (command) => {
      expect(await bash(command)).toBeNull();
    },
  );

  // L1 lets inline code and heredocs through to python and node (#89), so
  // the commands their code strings spell out are read too.
  test.each([
    'python -c "import os; os.system(\'git push origin main\')"',
    'python3 -c "import subprocess; subprocess.run([\'git\', \'push\', \'origin\', \'main\'])"',
    'python -c "import os; os.system(\\"git -C . push\\")"',
    "node -e \"require('child_process').execSync('git push origin main')\"",
    "node -e \"require('child_process').spawnSync('git', ['push', 'origin', 'main'])\"",
    'node --eval "require(\'child_process\').execSync(`gh auth token`)"',
    "python - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'push'], check=True)\nEOF",
    "node <<'EOF'\nconst { execSync } = require('node:child_process');\nexecSync(\"git remote add fork https://github.com/me/widgets.git\");\nEOF",
    'npm test && python -c "import os; os.system(\'git push\')"',
  ])('`%s` is refused', async (command) => {
    expect(await bash(command)).toMatch(/the factory pushes for you/);
  });

  test.each([
    'python -c "import subprocess; subprocess.run([\'git\', \'log\', \'--grep\', \'push\'])"',
    "python - <<'EOF'\nimport subprocess\nprint(subprocess.run(['git', 'status'], capture_output=True).stdout)\nEOF",
    "node -e \"console.log(require('./package.json').scripts.push)\"",
  ])('`%s` runs', async (command) => {
    expect(await bash(command)).toBeNull();
  });
});

describe('remotes, config and credentials', () => {
  test.each([
    'git remote add fork https://github.com/me/widgets.git',
    'git remote set-url origin https://github.com/me/widgets.git',
    'git remote set-url --push origin https://github.com/me/widgets.git',
    'git remote rename origin upstream',
    'git remote remove origin',
    'git config --global user.name me',
    'git config --system core.editor vim',
    'git config --global --unset credential.helper',
    'git config remote.origin.pushurl https://github.com/me/widgets.git',
    'git config set url.https://me@github.com/.insteadOf https://github.com/',
    'git config credential.helper store',
    'git config core.hooksPath .hooks',
    'git config --local core.hookspath .hooks',
    'git config include.path ../evil',
    'git config --remove-section remote.origin',
    'git config --rename-section remote.origin remote.upstream',
    'gh auth login',
    'gh auth token',
  ])('`%s` is refused', async (command) => {
    expect(await bash(command)).toMatch(/the factory pushes for you/);
  });

  test.each([
    'git remote -v',
    'git remote',
    'git remote get-url origin',
    'git remote show origin',
    'git config user.name',
    'git config --get remote.origin.url',
    'git config --global --get user.email',
    'git config --list',
    'git config core.autocrlf false',
    'gh issue view 39',
    'git fetch origin main',
  ])('`%s` runs', async (command) => {
    expect(await bash(command)).toBeNull();
  });
});

describe('branches and worktrees', () => {
  test.each([
    'git switch main',
    'git switch -c spike',
    'git checkout main',
    'git checkout -b spike',
    'git checkout -B factory/T1-fix-login main',
    'git checkout --orphan fresh',
    'git checkout --detach',
    'git checkout -',
    'git checkout B',
    'git worktree add ../other',
    'git worktree list',
    'git symbolic-ref HEAD refs/heads/main',
    'git rebase B main',
  ])('`%s` is refused', async (command) => {
    expect(await bash(command)).toMatch(/the factory pushes for you/);
  });

  test.each([
    'git checkout -- src/login.ts',
    'git checkout src/login.ts',
    'git checkout HEAD~1 -- src/login.ts',
    'git checkout main src/login.ts',
    'git checkout .',
    'git symbolic-ref HEAD',
    'git branch --show-current',
  ])('`%s` runs', async (command) => {
    expect(await bash(command)).toBeNull();
  });
});

describe('force and history rewrites', () => {
  test.each([
    'git reset --hard HEAD~3',
    'git reset --soft main',
    'git reset B',
    'git rebase -i HEAD~3',
    'git rebase main',
    'git rebase --onto main HEAD~1',
    'git rebase --root',
    'git pull --rebase origin main',
    'git branch -f main R2',
    'git branch -D spike',
    'git branch -M renamed',
    'git tag -f v1',
    'git update-ref refs/heads/main R2',
    'git filter-branch --tree-filter true',
    'git filter-repo --path src',
    'git replace R1 B',
    'git reflog expire --expire=now --all',
  ])('`%s` is refused', async (command) => {
    expect(await bash(command)).toMatch(/the factory pushes for you/);
  });

  test.each([
    'git reset --hard',
    'git reset --hard HEAD~2',
    'git reset --soft HEAD~1',
    'git reset src/login.ts',
    'git reset -- B',
    'git rebase -i HEAD~2',
    'git rebase --continue',
    'git commit --amend --no-edit',
    'git revert HEAD',
    'git merge main',
    'git cherry-pick B',
  ])('`%s` runs', async (command) => {
    expect(await bash(command)).toBeNull();
  });

  test('amending is refused once the run has no commit of its own to amend', async () => {
    const atStart: RunHistory = { isCommit: history.isCommit, keepsStart: async (rev) => rev === 'HEAD' };

    expect(await refusal({ tool: 'Bash', input: { command: 'git commit --amend -m "Fix"' } }, atStart)).toMatch(/the factory pushes for you/);
  });
});

describe('other tools', () => {
  test('PowerShell commands are read as Bash ones are', async () => {
    expect(await refusal({ tool: 'PowerShell', input: { command: 'git -C . push origin main; Get-ChildItem' } }, history)).toMatch(
      /the factory pushes for you/,
    );
    expect(await refusal({ tool: 'PowerShell', input: { command: 'git status' } }, history)).toBeNull();
  });

  test('EnterWorktree is refused', async () => {
    expect(await refusal({ tool: 'EnterWorktree', input: { name: 'spike' } }, history)).toMatch(/the factory pushes for you/);
  });
});

describe('files under .git', () => {
  test.each([
    ['Edit', { file_path: 'D:\\clones\\widgets\\.git\\config' }],
    ['Write', { file_path: '/clones/widgets/.git/hooks/pre-commit' }],
    ['NotebookEdit', { notebook_path: '.git/info/notebook.ipynb' }],
  ])('%s of %o is refused', async (tool, input) => {
    expect(await refusal({ tool, input }, history)).toMatch(/the factory pushes for you/);
  });

  test.each([
    ['Edit', { file_path: 'src/.gitignore' }],
    ['Write', { file_path: '.github/workflows/ci.yml' }],
    ['Read', { file_path: '.git/config' }],
  ])('%s of %o runs', async (tool, input) => {
    expect(await refusal({ tool, input }, history)).toBeNull();
  });
});
