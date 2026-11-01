// Seam 3: an L1 run's allow rules, matched by Claude Code's own permission
// engine (ADR 0007), on the operator's Windows machine. Spends a little
// subscription usage on haiku.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { expect, test } from 'vitest';
import type { RunEvent } from '../lifecycle/lifecycle.ts';
import { covers, FACTORY_ALLOW_LIST, type ToolCall } from '../permissions/permissions.ts';
import { waitFor } from '../os/test-support.ts';
import { agentSdkExecutor } from './agent-sdk.ts';
import type { ConversationEvent, RunStart } from './executor.ts';
import { afkRun } from './sdk-test-support.ts';

// A git repo with one commit, a few files to read and edit, and a bare
// `origin` a push would land in.
function repo(): { cwd: string; origin: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-l1-rules-'));
  const origin = mkdtempSync(join(tmpdir(), 'factory-l1-origin-'));
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true });
  git(origin, 'init', '--bare', '--quiet');
  git(cwd, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(cwd, 'notes.txt'), 'an owl\na heron\nan owl again\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'widgets', version: '1.0.0', private: true }));
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=Factory Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Start');
  git(cwd, 'remote', 'add', 'origin', origin);
  return { cwd, origin };
}

// What the run's Bash calls did: the commands the gate was asked about, and
// every command the agent ran, each on one line as the factory shows it.
type Replayed = { asked: string[]; ran: string[]; reported: RunEvent[] };

// The first message of a run that makes each call, in turn.
function runEach(commands: readonly string[]): string {
  return (
    'This is a permissions check. Run each command below with the Bash tool, exactly as written, one Bash call per command, ' +
    'in the order given. Never change, split or combine a command. A refused or failing command is expected: do not retry it ' +
    'or work around it, go straight on to the next. Once you have run them all, reply DONE.\n\n' +
    commands.map((command, index) => `Command ${index + 1}:\n\`\`\`bash\n${command}\n\`\`\``).join('\n\n')
  );
}

// Runs the L1 run to its end, refusing every call that reaches the gate, so
// only what Claude Code lets through runs.
async function replay(start: RunStart): Promise<Replayed> {
  const executor = agentSdkExecutor();
  const asked: ToolCall[] = [];
  const live: ConversationEvent[] = [];
  const reported: RunEvent[] = [];
  executor.start(
    start,
    {
      report: (event) => reported.push(event),
      converse: (event) => live.push(event),
      askPermission: (call) => {
        asked.push(call);
        executor.permit(start.runId, call.id, { allow: false, message: 'Refused in this check: go on to the next command.' });
      },
    },
  );
  await waitFor(() => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed'), 170_000);
  const ran = live.flatMap((event) => (event.type === 'toolUse' && event.tool === 'Bash' ? [event.summary] : []));
  return { asked: asked.filter((call) => call.tool === 'Bash').map((call) => call.summary), ran, reported };
}

const oneLine = (command: string) => command.replace(/\s+/g, ' ').trim();

// The shapes of the nine permission requests T8's L1 run on #46 raised when
// the factory's own matcher was the only one (A12 to A20), on this test's
// repo, then the parts they're made of, to tell which part asks.
const SHAPES = {
  // A12: chained reads, with `2>/dev/null` and pipes into `head`.
  'A12 chained reads': 'git config core.autocrlf; cat .gitattributes 2>/dev/null; git diff notes.txt | head -5; ls; cat *.md 2>/dev/null | head -80',
  // A13: pipes into `file`, `wc` and `sed -n`.
  'A13 pipes into file, wc and sed': "file notes.txt; git show HEAD:notes.txt | file -; git status --short | wc -l; git log --oneline | sed -n '1,200p'",
  // A14: `sed -n` and `grep` reads, chained.
  'A14 sed -n and grep reads': 'sed -n 1,2p notes.txt; grep -n "owl\\|heron" notes.txt | head -60',
  // A15: an install from the lockfile, then a test runner.
  'A15 npm ci then vitest': 'npm ci 2>&1 | tail -5; npx vitest run 2>&1 | tail -30',
  // A16 to A18: a heredoc fed to an interpreter that edits a worktree file.
  'A16 heredoc into python': "python - <<'EOF'\np='notes.txt'\ns=open(p).read()\nopen(p,'w').write(s.replace('an owl again','an owl, again'))\nEOF",
  // A19 and A20: an in-place `sed` edit chained with a type check.
  'A19 sed -i then tsc': 'sed -i "s/a heron/a grey heron/" notes.txt && npx tsc --noEmit 2>&1 | head',
  // The parts.
  'git config read': 'git config core.autocrlf',
  'glob read piped into head': 'cat *.md 2>/dev/null | head -80',
  'sed -i in the worktree': 'sed -i "s/grey heron/great heron/" notes.txt',
  'allow-listed, with 2>/dev/null': 'cat notes.txt 2>/dev/null',
  'allow-listed, piped into head': 'git log --oneline | head -5',
  'allow-listed, chained': 'git status --short && git log --oneline -3',
  'allow-listed, redirected into the worktree': 'git status --short > status.txt',
} as const;

// Where an L1 call ends up: Claude Code runs it unasked, or it reaches the
// gate, where the factory's matcher lets it through (a rule the operator
// added during the run is matched there too) or the operator is asked.
type Outcome = 'Claude Code allows' | 'factory matcher allows' | 'asks the operator';

test('an L1 run’s allow rules are matched by Claude Code itself; what still reaches the gate is recorded for #89', async () => {
  const { cwd } = repo();
  const shapes = Object.entries(SHAPES);

  const { asked, ran, reported } = await replay(afkRun(cwd, runEach(Object.values(SHAPES)), 40));

  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'runCompleted']);
  // The agent ran every command as given, so each outcome below is the rules'.
  expect(ran).toEqual(shapes.map(([, command]) => oneLine(command)));
  const outcomes = Object.fromEntries(
    shapes.map(([name, command]): [string, Outcome] => {
      if (!asked.includes(oneLine(command))) return [name, 'Claude Code allows'];
      return [name, covers(FACTORY_ALLOW_LIST, { tool: 'Bash', input: { command } }) ? 'factory matcher allows' : 'asks the operator'];
    }),
  );
  // The record, as of Agent SDK 0.3.312. Claude Code now lets A13 and A14
  // through: it splits chains and pipes, and takes `sed -n`, `file -`, `wc`,
  // globs, `2>/dev/null` and a redirect into the worktree as safe. What
  // still asks the operator is the gap #89 closes:
  // - `git config <key>` reads, which alone make A12 ask;
  // - `npm ci` (A15);
  // - a heredoc fed to `python` (A16 to A18);
  // - `sed -i`, even on a worktree file, which makes A19 and A20 ask.
  expect(outcomes).toEqual({
    'A12 chained reads': 'asks the operator',
    'A13 pipes into file, wc and sed': 'Claude Code allows',
    'A14 sed -n and grep reads': 'Claude Code allows',
    'A15 npm ci then vitest': 'asks the operator',
    'A16 heredoc into python': 'asks the operator',
    'A19 sed -i then tsc': 'asks the operator',
    'git config read': 'asks the operator',
    'glob read piped into head': 'Claude Code allows',
    'sed -i in the worktree': 'asks the operator',
    'allow-listed, with 2>/dev/null': 'Claude Code allows',
    'allow-listed, piped into head': 'Claude Code allows',
    'allow-listed, chained': 'Claude Code allows',
    'allow-listed, redirected into the worktree': 'Claude Code allows',
  });
});

test('a hard deny is refused without asking, even where an allow rule would let it through', async () => {
  const { cwd, origin } = repo();
  // An operator rule that matches every git command, `git push` included.
  const rules = [...FACTORY_ALLOW_LIST, 'Bash(git *)'];
  const pushes = ['git status --short && git push origin HEAD:refs/heads/main', 'git push origin main'];

  const start = afkRun(cwd, runEach(pushes), 10, rules);
  const { asked, ran, reported } = await replay(start);

  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'runCompleted']);
  expect(ran).toEqual(pushes);
  expect(asked).toEqual([]);
  // Nothing reached the remote.
  expect(execFileSync('git', ['-C', origin, 'for-each-ref'], { encoding: 'utf8', windowsHide: true })).toBe('');
  // Each push came back to the agent as the factory's refusal.
  const messages = await getSessionMessages(start.sessionId, { dir: cwd });
  const results = messages.flatMap((message) => {
    const content = (message.message as { content?: unknown } | null)?.content;
    return Array.isArray(content) ? content.filter((block) => block?.type === 'tool_result').map((block) => JSON.stringify(block.content)) : [];
  });
  const refused = expect.stringContaining('the factory pushes for you');
  expect(results).toEqual([refused, refused]);
});
