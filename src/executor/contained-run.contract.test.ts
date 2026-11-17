// Seam 3: real runs in a task's container, end to end, as the daemon starts
// them: L2 AFK runs, and contained HITL runs (ADR 0015), conversations that
// commit as the operator. The executor runs Claude Code in the task's Docker
// container on the operator's subscription token, the guards are checked in
// the container, and the run's commit comes out to the host task branch
// through a bundle. They spend a little usage on haiku, and need Docker and
// the token `agents-factory setup token` stored.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { factoryPaths } from '../daemon/paths.ts';
import { SUBSCRIPTION_TOKEN_SECRET } from '../daemon/daemon.ts';
import { FACTORY_IDENTITY, prepareRunGit } from '../guards/run-git.ts';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { waitFor } from '../os/test-support.ts';
import { dockerSandbox } from '../sandbox/docker.ts';
import { BUILT_IN_EGRESS, inRunDir, type Container, type OperatorProfile, type Sandbox } from '../sandbox/sandbox.ts';
import { windowsCredentials } from '../secrets/secrets.ts';
import type { GitIdentity, RunSnapshot } from '../git/git.ts';
import type { ToolCall } from '../permissions/permissions.ts';
import { agentSdkExecutor } from './agent-sdk.ts';
import type { ConversationEvent, Executor, RunStart } from './executor.ts';
import { afkRun, CODE_INTELLIGENCE_ERROR, CODE_INTELLIGENCE_TASK, typeScriptProject, typesOf } from './sdk-test-support.ts';

// The operator's own factory home, as `setup token` wrote it.
async function storedToken(): Promise<string> {
  const { AGENTS_FACTORY_HOME, ...env } = process.env;
  const token = await windowsCredentials(factoryPaths(env).credentialPrefix).read(SUBSCRIPTION_TOKEN_SECRET);
  if (!token) throw new Error('No subscription token is stored: run `claude setup-token`, then `agents-factory setup token`.');
  return token;
}

// The operator, as the host's git and a contained HITL run's commits name them.
const OPERATOR: GitIdentity = { name: 'Factory Test', email: 'test@example.com' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', `user.name=${OPERATOR.name}`, '-c', `user.email=${OPERATOR.email}`, ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

const BRANCH = 'factory/T1';

type ContainedRun = {
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
  // The calls that reached the factory's gate.
  asked: ToolCall[];
  ended: () => boolean;
};

// The runs that execute in a task's container: who each one's commits
// name, and how it starts beside an L1 run's start. An L2 run is the
// factory's, with max turns; a contained HITL run is the operator's
// conversation, with no level, turn limit or allow rules.
const KINDS = {
  L2: { identity: FACTORY_IDENTITY, start: { autonomy: 'L2' } },
  HITL: { identity: OPERATOR, start: { mode: 'HITL', autonomy: null, maxTurns: null, allowRules: [] } },
} as const satisfies Record<string, { identity: GitIdentity; start: Partial<RunStart> }>;

// Starts a run of `firstMessage` of `kind` in a fresh task's container, as
// the daemon would, over a repo of a README and `files`, and cleans the task
// up after `body`. Its container carries the operator's `profile` when
// given: the text of their user `CLAUDE.md` and of the project's `MEMORY.md`.
async function withContainedRun(
  firstMessage: string,
  body: (contained: ContainedRun) => Promise<void>,
  { files = {}, kind = 'L2', profile = null }: { files?: Record<string, string>; kind?: keyof typeof KINDS; profile?: { claudeMd: string; memory: string } | null } = {},
): Promise<void> {
  const token = await storedToken();
  const root = mkdtempSync(join(tmpdir(), 'factory-contained-run-'));
  const clonePath = join(root, 'clone');
  const worktree = join(root, 'worktree');
  git(root, 'init', '--quiet', '--initial-branch=main', clonePath);
  writeFileSync(join(clonePath, 'README.md'), 'widgets\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(clonePath, name), content);
  git(clonePath, 'add', '--all');
  git(clonePath, 'commit', '--quiet', '-m', 'Start');
  git(clonePath, 'worktree', 'add', '--quiet', '-b', BRANCH, worktree, 'main');
  const start = git(worktree, 'rev-parse', 'HEAD');

  const executor = agentSdkExecutor();
  const sandbox = dockerSandbox({ namespace: `agents-factory-contract-${randomBytes(4).toString('hex')}` });
  const sessionsDir = executor.sessionsDir(worktree);
  const runDir = join(root, 'run');
  // The operator's profile, as the host has it, in the temp directory.
  let carried: OperatorProfile | null = null;
  if (profile) {
    carried = { claudeMd: join(root, 'profile', 'CLAUDE.md'), memory: join(root, 'profile', 'memory') };
    mkdirSync(carried.memory, { recursive: true });
    writeFileSync(carried.claudeMd, profile.claudeMd);
    writeFileSync(join(carried.memory, 'MEMORY.md'), profile.memory);
  }
  try {
    const container = await sandbox.prepare({ taskId: 'T1', clonePath, branch: BRANCH, branches: [], plugin: null, runDir, sessionsDir, egress: [...BUILT_IN_EGRESS], profile: carried });
    const snapshot = await container.checks.snapshot(container.workdir);
    const env = prepareRunGit(runDir, KINDS[kind].identity, { task: 'T1', run: 'R1', model: 'claude-haiku-5-5' }, snapshot.checkout);
    const run: RunStart = {
      ...afkRun(worktree, firstMessage, 10),
      ...KINDS[kind].start,
      credential: 'subscription-token',
      token,
      container,
      guards: { start: snapshot.head, env: inRunDir(env, runDir) },
    };
    const reported: RunEvent[] = [];
    const live: ConversationEvent[] = [];
    const asked: ToolCall[] = [];
    executor.start(run, {
      report: (event) => reported.push(event),
      converse: (event) => live.push(event),
      // A call that reaches the gate is let through, as the daemon's gate would for a run in a container.
      askPermission: (call) => {
        asked.push(call);
        executor.permit('R1', call.id, { allow: true });
      },
    });
    const ended = () => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed');
    try {
      await body({ executor, sandbox, container, snapshot, run, worktree, start, reported, live, asked, ended });
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
  withContainedRun(
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
  withContainedRun(
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

test('an L2 run looks up symbols through its container’s language server, and sees the type error its edit introduces', () =>
  withContainedRun(
    CODE_INTELLIGENCE_TASK,
    async ({ container, reported, live, ended }) => {
      await waitFor(ended, 290_000);

      expect(typesOf(reported)).toEqual(['runStarted', 'runCompleted']);
      expect(live).toContainEqual(expect.objectContaining({ type: 'toolUse', tool: 'LSP' }));
      expect(live.at(-1)).toMatchObject({ type: 'message', from: 'agent', text: expect.stringContaining(CODE_INTELLIGENCE_ERROR) });
      expect(await container.deniedHosts()).toEqual([]);
    },
    { files: typeScriptProject() },
  ), 600_000);

test('a contained HITL run converses in its container: its question is a card, it takes the operator’s next message, nothing asks, and it commits as the operator', () =>
  withContainedRun(
    'Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options: Red and Blue. ' +
      'After I answer, reply with only the colour I chose, in capitals.',
    async ({ executor, sandbox, container, snapshot, worktree, reported, live, asked }) => {
      const turnsEnded = () => reported.filter((event) => event.type === 'turnEnded').length;
      const agentSaid = (text: string) => live.some((event) => event.type === 'message' && event.from === 'agent' && event.text.includes(text));
      const question = () => reported.find((event) => event.type === 'questionAsked');
      await waitFor(() => question() !== undefined || reported.some((event) => event.type === 'runFailed'), 120_000);
      const card = (question() as Extract<RunEvent, { type: 'questionAsked' }>).question;
      // The card holds the turn open.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(turnsEnded()).toBe(0);

      executor.answer('R1', card.id, { [card.questions[0]!.question]: 'Blue' });
      await waitFor(() => turnsEnded() === 1, 120_000);
      expect(agentSaid('BLUE')).toBe(true);

      executor.send(
        'R1',
        'Run these commands with the Bash tool, one call each: `echo "notes from the grill" > notes.txt`, then `git add notes.txt`, ' +
          'then `git commit -m "Keep the grill notes"`. Then reply with only DONE.',
      );
      await waitFor(() => turnsEnded() === 2, 290_000);

      expect(typesOf(reported)).toEqual(['runStarted', 'questionAsked', 'turnEnded', 'turnEnded']);
      expect(agentSaid('DONE')).toBe(true);
      // No call asked: the container, not the gate, keeps the run safe.
      expect(asked).toEqual([]);
      expect(await container.deniedHosts()).toEqual([]);
      const { stdout } = await container.git(['log', '-1', '--format=%an <%ae>|%cn <%ce>%n%B']);
      expect(stdout).toContain(`${OPERATOR.name} <${OPERATOR.email}>|${OPERATOR.name} <${OPERATOR.email}>`);
      expect(stdout).toContain('Factory-Run: R1');
      // Guarded as an L2 run is, under the operator's email.
      expect(await container.checks.violations(container.workdir, snapshot, [], OPERATOR.email)).toEqual([]);
      const tip = await sandbox.bringOut('T1', worktree, BRANCH);
      expect(git(worktree, 'show', `${tip}:notes.txt`)).toBe('notes from the grill');
    },
    { kind: 'HITL' },
  ), 600_000);

test('a contained HITL run’s instructions include the operator’s user CLAUDE.md, and it reads the project’s auto memory, which it can’t change', () =>
  withContainedRun(
    'Without using any tool, reply with only two words: the codeword your user instructions give, then the codename your auto memory gives for this project.',
    async ({ executor, container, reported, live, asked }) => {
      const turnsEnded = () => reported.filter((event) => event.type === 'turnEnded').length;
      await waitFor(() => turnsEnded() === 1 || reported.some((event) => event.type === 'runFailed'), 120_000);

      expect(typesOf(reported)).toEqual(['runStarted', 'turnEnded']);
      const replies = live.filter((event) => event.type === 'message' && event.from === 'agent').map((event) => (event as { text: string }).text);
      expect(replies.join('\n')).toMatch(/PERIWINKLE.*MARMALADE/s);

      executor.send('R1', `Run this command with the Bash tool: \`echo "- Remember this" >> ${container.memory}/MEMORY.md\`. Then reply with only whether it succeeded: YES or NO.`);
      await waitFor(() => turnsEnded() === 2, 120_000);
      expect(live.at(-1)).toMatchObject({ type: 'message', from: 'agent', text: expect.stringMatching(/^\W*NO\W*$/) });
      expect(asked).toEqual([]);
    },
    {
      kind: 'HITL',
      profile: {
        claudeMd: '# My preferences\n\nThe codeword is PERIWINKLE.\n',
        memory: '# Project memory\n\n- This project’s codename is MARMALADE.\n',
      },
    },
  ), 600_000);
