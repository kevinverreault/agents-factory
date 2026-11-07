// Seam 3: the Docker adapter against the real Docker engine, with throwaway
// clones in a temp directory. The first run builds the sandbox image, which
// pulls a Node base image and installs the pinned SDK's Linux CLI.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { FACTORY_IDENTITY, prepareRunGit } from '../guards/run-git.ts';
import { dockerSandbox } from './docker.ts';
import { inRunDir, type Container, type Sandbox } from './sandbox.ts';
import { describeSandboxContract, type SandboxFixture } from './sandbox-contract.ts';

// The image build can take minutes the first time.
const BUILD_MS = 15 * 60_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Factory Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// Runs `script` with `sh` in the container, with exactly `env` set besides the
// image's own, and gives its exit code and output.
function sh(container: Container, script: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done, fail) => {
    const child = container.spawn('sh', ['-c', script], { env });
    let stdout = '';
    child.stdout!.on('data', (chunk) => (stdout += chunk));
    child.stdin!.end();
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout }));
  });
}

let edits = 0;

type DockerFixture = SandboxFixture & { root: string };

async function fixture(): Promise<DockerFixture> {
  const root = mkdtempSync(join(tmpdir(), 'factory-sandbox-'));
  const sandbox = dockerSandbox({ namespace: `agents-factory-contract-${randomBytes(4).toString('hex')}` });
  return {
    root,
    sandbox,
    async task(taskId) {
      const clonePath = join(root, `${taskId}-clone`);
      const worktree = join(root, `${taskId}-worktree`);
      const branch = `factory/${taskId}`;
      git(root, 'init', '--quiet', '--initial-branch=main', clonePath);
      writeFileSync(join(clonePath, 'README.md'), 'widgets\n');
      git(clonePath, 'add', 'README.md');
      git(clonePath, 'commit', '--quiet', '-m', 'Start');
      git(clonePath, 'worktree', 'add', '--quiet', '-b', branch, worktree, 'main');
      const spec = { taskId, clonePath, branch, branches: [], plugin: null, runDir: join(root, `${taskId}-run`), sessionsDir: join(root, `${taskId}-sessions`) };
      return { spec, worktree };
    },
    async commitOnHost(worktree) {
      writeFileSync(join(worktree, `host-${++edits}.txt`), `${edits}\n`);
      git(worktree, 'add', '--all');
      git(worktree, 'commit', '--quiet', '-m', `Host ${edits}`);
      return git(worktree, 'rev-parse', 'HEAD');
    },
    async branchOnHost(spec, branch) {
      git(spec.clonePath, 'branch', branch, spec.branch);
      const tip = git(spec.clonePath, 'commit-tree', '-p', branch, '-m', `On ${branch}`, `${branch}^{tree}`);
      git(spec.clonePath, 'update-ref', `refs/heads/${branch}`, tip);
      return tip;
    },
    async commitInContainer(container) {
      const n = ++edits;
      const { code, stdout } = await sh(
        container,
        `echo ${n} > container-${n}.txt && git add --all && git -c user.name=Agent -c user.email=agent@example.com commit --quiet -m "Container ${n}" && git rev-parse HEAD`,
      );
      if (code !== 0) throw new Error(`The commit in the container failed: ${stdout}`);
      return stdout.trim();
    },
    async hostTip(spec, branch) {
      return git(spec.clonePath, 'rev-parse', `refs/heads/${branch}`);
    },
    async containerTip(container, branch) {
      return (await container.git(['rev-parse', `refs/heads/${branch}`])).stdout.trim();
    },
    async dispose() {
      for (const { taskId } of await sandbox.list()) await sandbox.remove(taskId);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

// The image is built once, before the first test that needs it times out on it.
beforeAll(async () => {
  const warm = await fixture();
  try {
    await warm.sandbox.prepare((await warm.task('T0')).spec);
  } finally {
    await warm.dispose();
  }
}, BUILD_MS);

describeSandboxContract('the Docker sandbox', fixture);

describe('the Docker sandbox: containment', () => {
  async function withTask(body: (fixture: DockerFixture, sandbox: Sandbox, container: Container, worktree: string) => Promise<void>) {
    const f = await fixture();
    try {
      const { spec, worktree } = await f.task('T1');
      const plugin = join(f.root, 'plugin');
      mkdirSync(plugin);
      writeFileSync(join(plugin, 'SKILL.md'), 'skill\n');
      await body(f, f.sandbox, await f.sandbox.prepare({ ...spec, plugin }), worktree);
    } finally {
      await f.dispose();
    }
  }

  test('the container runs as a non-root user and holds no credential', () =>
    withTask(async (_f, _sandbox, container) => {
      const { stdout } = await sh(container, 'id -u; env');
      const [uid, ...env] = stdout.trim().split('\n');

      expect(uid).not.toBe('0');
      const names = env.map((line) => line.split('=', 1)[0]);
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS']) {
        expect(names).not.toContain(name);
      }
      expect((await sh(container, 'ls -A ~/.ssh ~/.config/gh ~/.git-credentials 2>/dev/null | wc -l')).stdout.trim()).toBe('0');
    }));

  test('only the host clone’s git directory goes in, read-only, so nothing in the container can push to it, and the skill set is read-only too', () =>
    withTask(async (f, sandbox, container) => {
      const { spec } = await f.task('T2');
      writeFileSync(join(spec.clonePath, '.env'), 'SECRET=1\n');
      const other = await sandbox.prepare(spec);
      // The operator's working files, untracked ones included, stay out.
      expect((await sh(other, 'test -e /mnt/repo/.env || test -e /mnt/repo/README.md')).code).not.toBe(0);
      expect((await sh(other, 'test -e /mnt/repo/HEAD')).code).toBe(0);

      expect((await sh(container, 'touch /mnt/repo/written')).code).not.toBe(0);
      expect((await container.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/pushed'])).code).not.toBe(0);
      expect((await sh(container, `cat ${container.plugin}/SKILL.md`)).stdout).toBe('skill\n');
      expect((await sh(container, `touch ${container.plugin}/SKILL.md`)).code).not.toBe(0);
    }));

  test('a variable a run is handed reaches only that run', () =>
    withTask(async (_f, _sandbox, container) => {
      expect((await sh(container, 'echo "$CLAUDE_CODE_OAUTH_TOKEN"', { CLAUDE_CODE_OAUTH_TOKEN: 'secret' })).stdout.trim()).toBe('secret');
      expect((await sh(container, 'echo "${CLAUDE_CODE_OAUTH_TOKEN:-none}"')).stdout.trim()).toBe('none');
    }));

  test('a run’s git config and hooks from the run directory hold in the container: its commits carry the trailers, and pushes fail in git', () =>
    withTask(async (f, sandbox) => {
      const { spec } = await f.task('T2');
      const env = inRunDir(prepareRunGit(spec.runDir, FACTORY_IDENTITY, { task: 'T2', run: 'R9', model: 'claude-test' }), spec.runDir);
      const run = await sandbox.prepare(spec);

      const committed = await sh(run, 'echo x > x.txt && git add x.txt && git commit --quiet -m "Work" && git log -1 --format="%an%n%B"', env);
      const pushed = await sh(run, 'git push origin HEAD:refs/heads/elsewhere 2>&1', env);

      expect(committed.code).toBe(0);
      expect(committed.stdout).toContain(FACTORY_IDENTITY.name);
      expect(committed.stdout).toContain('Factory-Task: T2');
      expect(committed.stdout).toContain('Factory-Run: R9');
      expect(pushed.code).not.toBe(0);
      expect(pushed.stdout).toContain('the-factory-pushes-for-you');
    }));

  test('the sessions directory is the CLI’s project directory for the workdir, shared with the host', () =>
    withTask(async (f, _sandbox, container) => {
      expect((await sh(container, 'echo {} > ~/.claude/projects/-work/S1.jsonl')).code).toBe(0);
      expect(existsSync(join(f.root, 'T1-sessions', 'S1.jsonl'))).toBe(true);
    }));

  test('the container’s CLI is the Linux build of the one the pinned SDK bundles', () =>
    withTask(async (_f, _sandbox, container) => {
      const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
      const { version } = JSON.parse(readFileSync(join(dirname(entry), 'manifest.json'), 'utf8')) as { version: string };

      const { code, stdout } = await sh(container, 'claude --version');

      expect(code).toBe(0);
      expect(stdout).toContain(version);
    }));

  test('a restart kills a turn still running in the container, and the docker exec that started it ends', () =>
    withTask(async (_f, sandbox, container) => {
      const stale = container.spawn('sh', ['-c', 'sleep 5; touch /tmp/stale-turn'], { env: {} });
      const ended = new Promise((done) => stale.on('close', done));

      await sandbox.restart('T1');
      await ended;
      await new Promise((done) => setTimeout(done, 7_000));

      expect((await sh(container, 'test -e /tmp/stale-turn')).code).not.toBe(0);
    }));
});
