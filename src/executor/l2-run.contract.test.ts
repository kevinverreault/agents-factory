// Seam 3: real L2 AFK runs, end to end, as the daemon starts them: the
// executor runs Claude Code in the task's Docker container on the operator's
// subscription token, the guards are checked in the container, and the run's
// commit comes out to the host task branch through a bundle. They spend a
// little usage on haiku, and need Docker and the token `agents-factory setup
// token` stored.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { factoryPaths } from '../daemon/paths.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from '../daemon/daemon.ts';
import { FACTORY_IDENTITY, prepareRunGit } from '../guards/run-git.ts';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { waitFor } from '../os/test-support.ts';
import { dockerSandbox } from '../sandbox/docker.ts';
import { BUILT_IN_EGRESS, inRunDir, type Container, type Sandbox } from '../sandbox/sandbox.ts';
import { windowsCredentials } from '../secrets/secrets.ts';
import type { RunSnapshot } from '../git/git.ts';
import { agentSdkExecutor } from './agent-sdk.ts';
import type { ConversationEvent, Executor, RunStart } from './executor.ts';
import { afkRun, typesOf } from './sdk-test-support.ts';

// The operator's own factory home, as `setup token` wrote it.
async function storedToken(): Promise<string> {
  const { AGENTS_FACTORY_HOME, ...env } = process.env;
  const token = await windowsCredentials(factoryPaths(env).credentialPrefix).read(SUBSCRIPTION_TOKEN_SECRET);
  if (!token) throw new Error('No subscription token is stored: run `claude setup-token`, then `agents-factory setup token`.');
  return token;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Factory Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

const BRANCH = 'factory/T1';

type L2Run = {
  executor: Executor;
  sandbox: Sandbox;
  container: Container;
  snapshot: RunSnapshot;
  run: RunStart;
  worktree: string;
  // The task branch's tip on the host before the run.
  start: string;
  reported: RunEvent[];
  live: ConversationEvent[];
  ended: () => boolean;
};

// Starts an L2 run of `firstMessage` in a fresh task's container, as the
// daemon would, and cleans the task up after `body`.
async function withL2Run(firstMessage: string, body: (l2: L2Run) => Promise<void>): Promise<void> {
  const token = await storedToken();
  const root = mkdtempSync(join(tmpdir(), 'factory-l2-run-'));
  const clonePath = join(root, 'clone');
  const worktree = join(root, 'worktree');
  git(root, 'init', '--quiet', '--initial-branch=main', clonePath);
  writeFileSync(join(clonePath, 'README.md'), 'widgets\n');
  git(clonePath, 'add', 'README.md');
  git(clonePath, 'commit', '--quiet', '-m', 'Start');
  git(clonePath, 'worktree', 'add', '--quiet', '-b', BRANCH, worktree, 'main');
  const start = git(worktree, 'rev-parse', 'HEAD');

  const executor = agentSdkExecutor();
  const sandbox = dockerSandbox({ namespace: `agents-factory-contract-${randomBytes(4).toString('hex')}` });
  const sessionsDir = executor.sessionsDir(worktree);
  const runDir = join(root, 'run');
  try {
    const container = await sandbox.prepare({ taskId: 'T1', clonePath, branch: BRANCH, branches: [], plugin: null, runDir, sessionsDir, egress: [...BUILT_IN_EGRESS] });
    const snapshot = await container.checks.snapshot(container.workdir);
    const env = prepareRunGit(runDir, FACTORY_IDENTITY, { task: 'T1', run: 'R1', model: 'claude-haiku-5-5' }, snapshot.checkout);
    const run: RunStart = {
      ...afkRun(worktree, firstMessage, 10),
      autonomy: 'L2',
      credential: 'subscription-token',
      token,
      container,
      guards: { start: snapshot.head, env: inRunDir(env, runDir) },
    };
    const reported: RunEvent[] = [];
    const live: ConversationEvent[] = [];
    executor.start(run, {
      report: (event) => reported.push(event),
      converse: (event) => live.push(event),
      // A call that reaches the gate is let through, as the daemon's gate would for a run in a container.
      askPermission: (call) => executor.permit('R1', call.id, { allow: true }),
    });
    const ended = () => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed');
    try {
      await body({ executor, sandbox, container, snapshot, run, worktree, start, reported, live, ended });
    } finally {
      executor.stop('R1');
    }
  } finally {
    await sandbox.remove('T1');
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test('an L2 run commits in its container on the subscription token, keeps the guards, and its commit comes out to the host task branch', () =>
  withL2Run(
    'Run these commands with the Bash tool, one call each: `echo "hello from the container" > hello.txt`, then `git add hello.txt`, ' +
      'then `git commit -m "Say hello"`. Then reply with only DONE.',
    async ({ executor, sandbox, container, snapshot, run, worktree, start, reported, live, ended }) => {
      await waitFor(ended, 290_000);

      expect(reported.find((event) => event.type === 'runFailed')).toBeUndefined();
      expect(typesOf(reported)).toEqual(['runStarted', 'runCompleted']);
      expect(live.filter((event) => event.type === 'toolUse').map((event) => event.tool)).toEqual(['Bash', 'Bash', 'Bash']);
      // The CLI reached the Claude API through the egress proxy on the built-in hosts alone.
      expect(await container.deniedHosts()).toEqual([]);
      // The host's worktree is untouched until the commit comes out.
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(start);

      expect(await container.checks.violations(container.workdir, snapshot, [], FACTORY_IDENTITY.email)).toEqual([]);
      const tip = await sandbox.bringOut('T1', worktree, BRANCH);

      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(tip);
      expect(git(worktree, 'rev-list', '--count', `${start}..${tip}`)).toBe('1');
      expect(git(worktree, 'show', `${tip}:hello.txt`)).toBe('hello from the container');
      const message = git(worktree, 'log', '-1', '--format=%an <%ae>%n%B', tip);
      expect(message).toContain(`${FACTORY_IDENTITY.name} <${FACTORY_IDENTITY.email}>`);
      expect(message).toContain('Factory-Task: T1');
      expect(message).toContain('Factory-Run: R1');
      // The session landed in the host's project dir for the worktree, through the shared mount.
      const history = await executor.history({ sessionId: run.sessionId, cwd: worktree });
      expect(history.some((event) => event.type === 'message' && event.from === 'agent' && event.text.includes('DONE'))).toBe(true);
    },
  ), 600_000);

test('an L2 run’s question reaches the operator as an attention request, holds the run open, and takes their answer', () =>
  withL2Run(
    'Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options: Red and Blue. ' +
      'After I answer, reply with only the colour I chose, in capitals.',
    async ({ executor, reported, live, ended }) => {
      const raised = () => reported.find((event) => event.type === 'attentionRaised');
      await waitFor(() => raised() !== undefined || ended(), 120_000);
      expect(typesOf(reported)).toEqual(['runStarted', 'attentionRaised']);
      const { question } = raised() as Extract<RunEvent, { type: 'attentionRaised'; kind: 'question' }>;
      // The request holds the run open.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(typesOf(reported)).toEqual(['runStarted', 'attentionRaised']);

      executor.answer('R1', question.id, { [question.questions[0]!.question]: 'Blue' });
      await waitFor(ended, 120_000);

      expect(typesOf(reported)).toEqual(['runStarted', 'attentionRaised', 'runCompleted']);
      expect(live.some((event) => event.type === 'message' && event.from === 'agent' && /blue/i.test(event.text))).toBe(true);
    },
  ), 600_000);
