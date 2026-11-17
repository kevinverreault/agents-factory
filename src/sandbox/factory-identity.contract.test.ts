// Seam 3: a contained HITL run's gh (ADR 0015, amending ADR 0004), in a real
// Docker container, as the factory identity's real App, against the GitHub
// contract's throwaway repository. It writes issues with the scoped token as
// the issue tracker doc's conventions do, while git still can't push. It
// needs Docker, and what the GitHub contract needs (see
// `github.contract.test.ts`): the stored App and `FACTORY_CONTRACT_REPO`,
// with the operator's own `gh` login, which reads what the run wrote and
// closes the issues it opened afterwards. Without them it is skipped.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { GITHUB_APP_SECRET } from '../daemon/daemon.ts';
import { factoryPaths } from '../daemon/paths.ts';
import { gitHubApi, ISSUES_WRITE, type FactoryApp } from '../github/github.ts';
import { writeRunGh } from '../github/run-gh.ts';
import { prepareRunGit } from '../guards/run-git.ts';
import { windowsCredentials } from '../secrets/secrets.ts';
import { dockerSandbox } from './docker.ts';
import { BUILT_IN_EGRESS, inRunDir, type Container } from './sandbox.ts';

const execFileAsync = promisify(execFile);
const repo = process.env.FACTORY_CONTRACT_REPO;
// The image build can take minutes the first time.
const BUILD_MS = 15 * 60_000;

// The operator's own factory home, as `setup github` wrote it.
async function storedApp(): Promise<FactoryApp> {
  const { AGENTS_FACTORY_HOME, ...env } = process.env;
  const stored = await windowsCredentials(factoryPaths(env).credentialPrefix).read(GITHUB_APP_SECRET);
  if (!stored) throw new Error('No factory App is stored: run `agents-factory setup github` first.');
  return JSON.parse(stored) as FactoryApp;
}

// Runs `script` with `sh` in the container, with exactly `env` set besides
// the image's own, and gives its exit code and output, stderr included.
function sh(container: Container, script: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done, fail) => {
    const child = container.spawn('sh', ['-c', `(${script}) 2>&1`], { env });
    let stdout = '';
    child.stdout!.on('data', (chunk) => (stdout += chunk));
    child.stdin!.end();
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout: stdout.trim() }));
  });
}

// `gh api` as the operator, on the host, with their own login.
async function operatorApi(...args: string[]): Promise<any> {
  return JSON.parse((await execFileAsync('gh', ['api', ...args])).stdout);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Factory Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

if (!repo) {
  describe.skip('a contained run’s gh as the factory identity (set FACTORY_CONTRACT_REPO to run it)', () => test('needs a throwaway repository', () => {}));
} else {
  const opened: number[] = [];
  afterAll(async () => {
    for (const number of opened) await execFileAsync('gh', ['issue', 'close', String(number), '--repo', repo, '--comment', 'Closed by the contract test.']);
  });

  describe('a contained run’s gh as the factory identity', () => {
    test(
      'writes issues, sub-issues, labels, dependencies and claims with the scoped token, while git push still fails',
      async () => {
        const app = await storedApp();
        const operator = (await execFileAsync('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
        const root = mkdtempSync(join(tmpdir(), 'factory-identity-'));
        const sandbox = dockerSandbox({ namespace: `agents-factory-contract-${randomBytes(4).toString('hex')}` });
        try {
          const clonePath = join(root, 'clone');
          git(root, 'init', '--quiet', '--initial-branch=main', clonePath);
          writeFileSync(join(clonePath, 'README.md'), 'widgets\n');
          git(clonePath, 'add', 'README.md');
          git(clonePath, 'commit', '--quiet', '-m', 'Start');
          git(clonePath, 'branch', 'factory/T1');
          const runDir = join(root, 'run');
          const container = await sandbox.prepare({
            taskId: 'T1',
            clonePath,
            branch: 'factory/T1',
            branches: [],
            plugin: null,
            runDir,
            sessionsDir: join(root, 'sessions'),
            egress: [...BUILT_IN_EGRESS],
          });
          // The run's environment as the daemon gives a contained HITL run.
          const { token } = await gitHubApi().mintToken(app, repo, ISSUES_WRITE);
          const env = inRunDir(
            {
              ...prepareRunGit(runDir, { name: 'Contract Operator', email: 'operator@example.invalid' }, { task: 'T1', run: 'R1', model: 'claude-test' }),
              ...writeRunGh(join(runDir, 'gh'), `${app.slug}[bot]`, token),
              GH_REPO: repo,
              FACTORY_OPERATOR_LOGIN: operator,
            },
            runDir,
          );
          const run = async (script: string) => {
            const result = await sh(container, script, env);
            expect(result, script).toMatchObject({ code: 0 });
            return result.stdout;
          };
          const create = async (title: string) => {
            const url = (await run(`gh issue create --title "${title}" --body "Opened by the factory identity contract test."`)).split('\n').at(-1)!;
            const number = Number(url.split('/').at(-1));
            opened.push(number);
            return { number, id: Number(await run(`gh api repos/{owner}/{repo}/issues/${number} --jq .id`)) };
          };

          const parent = await create('Contract test: a spec');
          const child = await create('Contract test: a ticket');
          const blocker = await create('Contract test: its blocker');
          await run(`gh api --method POST repos/{owner}/{repo}/issues/${parent.number}/sub_issues -F sub_issue_id=${child.id}`);
          await run(`gh api --method POST repos/{owner}/{repo}/issues/${child.number}/dependencies/blocked_by -F issue_id=${blocker.id}`);
          await run('gh label create factory-contract --force --description "The factory identity contract test"');
          await run(`gh issue edit ${child.number} --add-label factory-contract`);
          await run(`gh issue edit ${child.number} --add-assignee "\${FACTORY_OPERATOR_LOGIN:-@me}"`);

          const written = await operatorApi(`repos/${repo}/issues/${child.number}`);
          expect(written.user.login).toBe(`${app.slug}[bot]`);
          expect(written.labels.map(({ name }: { name: string }) => name)).toContain('factory-contract');
          expect(written.assignees.map(({ login }: { login: string }) => login)).toEqual([operator]);
          expect((await operatorApi(`repos/${repo}/issues/${parent.number}/sub_issues`)).map(({ number }: { number: number }) => number)).toEqual([child.number]);
          expect((await operatorApi(`repos/${repo}/issues/${child.number}/dependencies/blocked_by`)).map(({ number }: { number: number }) => number)).toEqual([blocker.number]);

          // git can't push: not as the run's git config has it, and not with
          // the token itself, without that config, which has no Contents write.
          await run('echo x > x.txt && git add x.txt && git commit --quiet -m "Work"');
          const pushed = await sh(container, 'git push origin HEAD:refs/heads/elsewhere', env);
          expect(pushed.code).not.toBe(0);
          expect(pushed.stdout).toContain('the-factory-pushes-for-you');
          const branch = `factory-contract-${randomBytes(4).toString('hex')}`;
          const unguarded = 'env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_COUNT git';
          const direct = await sh(container, `${unguarded} push "https://x-access-token:${token}@github.com/${repo}.git" HEAD:refs/heads/${branch}`, env);
          expect(direct.code).not.toBe(0);
          expect((await execFileAsync('git', ['ls-remote', '--heads', `https://github.com/${repo}.git`, branch])).stdout.trim()).toBe('');
        } finally {
          for (const { taskId } of await sandbox.list()) await sandbox.remove(taskId);
          rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      },
      BUILD_MS,
    );
  });
}
