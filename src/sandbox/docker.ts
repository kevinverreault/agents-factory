// The Docker adapter behind the Sandbox port (ADR 0007, ADR 0011). One
// container per task, from one image per factory version that the adapter
// builds itself the first time a container needs it. The container runs as a
// non-root user, clones the host clone from a read-only mount of its git
// directory alone (the operator's working files, untracked ones included,
// stay out), gets the
// skill set copied in read-only, and holds no credential: whatever a run
// needs, it is handed through `docker exec`'s environment for that run alone.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { GitError, guardChecks } from '../git/git.ts';
import { RUN_DIR, SandboxError, type Container, type ContainerListing, type ContainerSpec, type GitResult, type Sandbox } from './sandbox.ts';

const WORKDIR = '/work';
const PLUGIN_DIR = '/opt/factory/plugin';
// The CLI's project directory for runs in `WORKDIR`, as Claude Code names it.
const SESSIONS_DIR = '/home/agent/.claude/projects/-work';
const USER = 'agent';
const TASK_LABEL = 'agents-factory.task';
const NAMESPACE_LABEL = 'agents-factory.namespace';
const IMAGE_LABEL = 'agents-factory.sandbox';
const REPOSITORY = 'agents-factory-sandbox';
// How long a stopped container's processes get before they are killed.
const STOP_SECONDS = '3';

// The image's recipe. The CLI is the Linux build of the one the pinned SDK
// bundles, so a run in the container is the same Claude Code as on the host.
export function sandboxDockerfile(sdkVersion: string): string {
  return [
    'FROM node:24-bookworm-slim',
    'RUN apt-get update \\',
    ' && apt-get install --yes --no-install-recommends git ca-certificates gh \\',
    ' && rm -rf /var/lib/apt/lists/*',
    `RUN npm install --global @anthropic-ai/claude-agent-sdk-linux-x64@${sdkVersion} \\`,
    ' && ln -s "$(npm root --global)/@anthropic-ai/claude-agent-sdk-linux-x64/claude" /usr/local/bin/claude',
    // The clone it fetches from is mounted, so owned by someone else.
    "RUN git config --system safe.directory '*' \\",
    ` && useradd --create-home --uid 10001 ${USER} \\`,
    ` && mkdir -p ${WORKDIR} ${PLUGIN_DIR} ${RUN_DIR} ${SESSIONS_DIR} \\`,
    ` && chown ${USER}:${USER} ${WORKDIR} \\`,
    ` && chown -R ${USER}:${USER} /home/${USER}/.claude`,
    '',
  ].join('\n');
}

export type DockerSandboxOptions = {
  // Keeps one factory home's containers apart from another's: in their
  // names and in a label.
  namespace: string;
};

export function dockerSandbox({ namespace }: DockerSandboxOptions): Sandbox {
  const dockerfile = sandboxDockerfile(pinnedSdkVersion());
  const image = `${REPOSITORY}:${createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)}`;
  let built: Promise<void> | null = null;
  const nameOf = (taskId: string) => `${namespace}-${taskId}`.toLowerCase();

  // Builds the image unless it exists, then removes older factory images no
  // container uses (ADR 0011). Images the factory didn't build carry no label.
  function ensureImage(): Promise<void> {
    built ??= (async () => {
      if ((await docker(['image', 'inspect', image]).catch(() => null)) === null) {
        await docker(['build', '--quiet', '--label', `${IMAGE_LABEL}=true`, '--tag', image, '-'], { input: dockerfile });
      }
      const ours = (await docker(['image', 'ls', '--filter', `label=${IMAGE_LABEL}=true`, '--format', '{{.Repository}}:{{.Tag}}'])).split(/\r?\n/);
      for (const older of ours.filter((ref) => ref && ref !== image)) await docker(['image', 'rm', older]).catch(() => {});
    })();
    // A failed build is tried again next time.
    built.catch(() => (built = null));
    return built;
  }

  // Whether the task's container runs, or null when there is none.
  async function stateOf(taskId: string): Promise<boolean | null> {
    try {
      return (await docker(['container', 'inspect', '--format', '{{.State.Running}}', nameOf(taskId)])).trim() === 'true';
    } catch (error) {
      if (/no such (container|object)/i.test((error as Error).message)) return null;
      throw error;
    }
  }

  function gitIn(taskId: string, args: string[], cwd = WORKDIR): Promise<GitResult> {
    return run('docker', ['exec', '--user', USER, '--workdir', cwd, nameOf(taskId), 'git', ...args]);
  }

  async function gitOut(taskId: string, args: string[]): Promise<string> {
    const result = await gitIn(taskId, args);
    if (result.code !== 0) throw new SandboxError(result.stderr.trim() || `git ${args[0]} failed in ${taskId}’s container.`);
    return result.stdout.trim();
  }

  async function create(spec: ContainerSpec): Promise<void> {
    const name = nameOf(spec.taskId);
    const gitDir = await hostOut(spec.clonePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    mkdirSync(spec.runDir, { recursive: true });
    mkdirSync(spec.sessionsDir, { recursive: true });
    const mount = (source: string, target: string, readonly: boolean) => ['--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
    await docker([
      'create',
      '--name',
      name,
      '--label',
      `${NAMESPACE_LABEL}=${namespace}`,
      '--label',
      `${TASK_LABEL}=${spec.taskId}`,
      '--init',
      '--user',
      USER,
      '--workdir',
      WORKDIR,
      ...mount(gitDir, '/mnt/repo', true),
      ...mount(spec.runDir, RUN_DIR, true),
      ...mount(spec.sessionsDir, SESSIONS_DIR, false),
      image,
      'sleep',
      'infinity',
    ]);
    try {
      // Copied as root: the run's user can read the skill set, not change it.
      if (spec.plugin !== null) await docker(['cp', `${spec.plugin}/.`, `${name}:${PLUGIN_DIR}`]);
      await docker(['start', name]);
      await gitOut(spec.taskId, ['clone', '--quiet', '--no-local', '--branch', spec.branch, '/mnt/repo', WORKDIR]);
    } catch (error) {
      await docker(['rm', '--force', name]).catch(() => {});
      throw error;
    }
  }

  function handle(spec: ContainerSpec): Container {
    const name = nameOf(spec.taskId);
    return {
      taskId: spec.taskId,
      workdir: WORKDIR,
      plugin: spec.plugin === null ? null : PLUGIN_DIR,
      checks: guardChecks({
        async output(cwd, args) {
          const result = await gitIn(spec.taskId, args, cwd);
          if (result.code !== 0) throw new GitError(result.stderr.trim() || `git ${args[0]} failed.`);
          return result.stdout;
        },
        async hooks(dir) {
          const listing = await run('docker', [
            'exec',
            '--user',
            USER,
            name,
            'sh',
            '-c',
            'cd "$1" 2>/dev/null || exit 0; for f in *; do [ -f "$f" ] && sha256sum "$f"; done; exit 0',
            'sh',
            dir,
          ]);
          return Object.fromEntries(
            listing.stdout.split('\n').flatMap((line) => {
              const [, hash, file] = /^([0-9a-f]{64}) {2}(.+)$/.exec(line) ?? [];
              return hash ? [[file!, hash]] : [];
            }),
          );
        },
        join: posix.join,
      }),
      git: (args) => gitIn(spec.taskId, args),
      spawn(command, args, { env, signal }) {
        // Values travel in docker's own environment, never on its command line.
        const names = Object.keys(env).filter((key) => env[key] !== undefined);
        return spawn('docker', ['exec', '--interactive', '--user', USER, '--workdir', WORKDIR, ...names.flatMap((key) => ['--env', key]), name, command, ...args], {
          env: { ...process.env, ...env },
          signal,
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      },
    };
  }

  // Fetches the host branches into the container's clone: the task branch
  // fast-forwards, the others are moved to the host's tips.
  async function bringIn(spec: ContainerSpec): Promise<void> {
    const { taskId, branch } = spec;
    const tracking = `refs/remotes/origin/${branch}`;
    await gitOut(taskId, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${tracking}`, ...spec.branches.map((other) => `+refs/heads/${other}:refs/heads/${other}`)]);
    const [mine, host] = await Promise.all([gitOut(taskId, ['rev-parse', `refs/heads/${branch}`]), gitOut(taskId, ['rev-parse', tracking])]);
    if (mine === host) return;
    if ((await gitIn(taskId, ['merge-base', '--is-ancestor', mine, host])).code === 0) {
      await gitOut(taskId, ['merge', '--ff-only', '--quiet', tracking]);
    } else if ((await gitIn(taskId, ['merge-base', '--is-ancestor', host, mine])).code !== 0) {
      throw new SandboxError(diverged(branch));
    }
  }

  return {
    async prepare(spec) {
      await ensureImage();
      const running = await stateOf(spec.taskId);
      if (running === null) await create(spec);
      else if (!running) await docker(['start', nameOf(spec.taskId)]);
      await bringIn(spec);
      return handle(spec);
    },

    async start(taskId) {
      if ((await stateOf(taskId)) === false) await docker(['start', nameOf(taskId)]);
    },

    async stop(taskId) {
      if (await stateOf(taskId)) await docker(['stop', '--time', STOP_SECONDS, nameOf(taskId)]);
    },

    async restart(taskId) {
      if ((await stateOf(taskId)) === null) return false;
      await docker(['restart', '--time', STOP_SECONDS, nameOf(taskId)]);
      return true;
    },

    async bringOut(taskId, worktreePath, branch) {
      if (!(await stateOf(taskId))) throw new SandboxError(`${taskId}’s container isn’t running.`);
      const checkedOut = await hostGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (checkedOut.stdout.trim() !== branch) throw new SandboxError(`${branch} isn’t checked out in ${worktreePath}.`);
      const [mine, host] = await Promise.all([gitOut(taskId, ['rev-parse', `refs/heads/${branch}`]), hostOut(worktreePath, ['rev-parse', `refs/heads/${branch}`])]);
      if (mine === host) return host;
      if ((await gitIn(taskId, ['merge-base', '--is-ancestor', host, mine])).code !== 0) {
        // The host is ahead, or the two diverged.
        if ((await hostGit(worktreePath, ['merge-base', '--is-ancestor', mine, host])).code === 0) return host;
        throw new SandboxError(diverged(branch));
      }
      const bundle = '/tmp/factory-out.bundle';
      await gitOut(taskId, ['bundle', 'create', '--quiet', bundle, `refs/heads/${branch}`, `^${host}`]);
      const dir = mkdtempSync(join(tmpdir(), 'factory-bundle-'));
      try {
        const file = join(dir, 'out.bundle');
        await docker(['cp', `${nameOf(taskId)}:${bundle}`, file]);
        await hostOut(worktreePath, ['fetch', '--quiet', file, `refs/heads/${branch}`]);
        await hostOut(worktreePath, ['merge', '--ff-only', '--quiet', 'FETCH_HEAD']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return mine;
    },

    async remove(taskId) {
      if ((await stateOf(taskId)) !== null) await docker(['rm', '--force', nameOf(taskId)]);
    },

    async list() {
      const listing = await docker(['ps', '--all', '--filter', `label=${NAMESPACE_LABEL}=${namespace}`, '--format', `{{.Label "${TASK_LABEL}"}}\t{{.State}}`]);
      return listing.split(/\r?\n/).flatMap((line): ContainerListing[] => {
        const [taskId, state] = line.trim().split('\t');
        return taskId ? [{ taskId, running: state === 'running' }] : [];
      });
    },
  };
}

function diverged(branch: string): string {
  return `${branch} has commits in the container and on the host that the other lacks, so neither can take the other’s.`;
}

// The SDK version the factory pins, whose CLI the image installs.
function pinnedSdkVersion(): string {
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  return (JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string }).version;
}

// Docker's output. Throws a `SandboxError` with Docker's own message when it fails.
async function docker(args: string[], { input }: { input?: string } = {}): Promise<string> {
  const result = await run('docker', args, input);
  if (result.code !== 0) throw new SandboxError(result.stderr.trim() || `docker ${args[0]} failed.`);
  return result.stdout;
}

function hostGit(cwd: string, args: string[]): Promise<GitResult> {
  return run('git', ['-C', cwd, ...args]);
}

async function hostOut(cwd: string, args: string[]): Promise<string> {
  const result = await hostGit(cwd, args);
  if (result.code !== 0) throw new SandboxError(result.stderr.trim() || `git ${args[0]} failed in ${cwd}.`);
  return result.stdout.trim();
}

// Runs the command to its end: its exit code and output. Docker that can't
// be found at all counts as a failure, with its own message.
function run(command: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((done) => {
    const child = execFile(command, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0;
      done({ code, stdout, stderr: stderr || (error && code === 127 ? error.message : '') });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}
