// Seam 3: an L1 run's allow rules, matched by Claude Code's own permission
// engine (ADR 0007), on the operator's Windows machine. Spends a little
// subscription usage on haiku.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

// A git repo with one commit, a few files to read and edit, a script, a
// binary the project installed, and a bare `origin` a push would land in.
function repo(): { cwd: string; origin: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-l1-rules-'));
  const origin = mkdtempSync(join(tmpdir(), 'factory-l1-origin-'));
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true });
  git(origin, 'init', '--bare', '--quiet');
  git(cwd, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(cwd, 'notes.txt'), 'an owl\na heron\nan owl again\n');
  const scripts = { test: 'node -e "console.log(\'TESTED\')"' };
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'widgets', version: '1.0.0', private: true, scripts }));
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(join(cwd, 'scripts', 'count.py'), "print(open('notes.txt').read().count('owl'))\n");
  git(cwd, 'add', '.');
  // Installed, so not committed.
  mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(cwd, 'node_modules', '.bin', 'owls'), '#!/bin/sh\necho owls\n');
  git(cwd, '-c', 'user.name=Factory Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Start');
  git(cwd, 'remote', 'add', 'origin', origin);
  return { cwd, origin };
}

// What the run did: the Bash commands the gate was asked about and every
// Bash command the agent ran, each on one line as the factory shows it, and
// the run events it reported.
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
  await waitFor(() => reported.some((event) => event.type === 'runCompleted' || event.type === 'runFailed'), 290_000);
  const ran = live.flatMap((event) => (event.type === 'toolUse' && event.tool === 'Bash' ? [event.summary] : []));
  return { asked: asked.filter((call) => call.tool === 'Bash').map((call) => call.summary), ran, reported };
}

const oneLine = (command: string) => command.replace(/\s+/g, ' ').trim();

// The shapes of the nine permission requests T8's L1 run on #46 raised when
// the factory's own matcher was the only one (A12 to A20), on this test's
// repo, then the parts they're made of, to tell which part asks, then what
// else AFK runs reach for (#89), and what must still ask.
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
  // Calls Claude Code lets through only by an allow rule.
  'allow-listed only': 'npm test',
  'allow-listed only, piped and chained': 'npm test 2>&1 | tail -5 && git status --short',
  // What else AFK runs reach for.
  'git config --get': 'git config --get core.autocrlf',
  'cd within the worktree': 'cd scripts && ls',
  'python -c': 'python -c "print(\'an owl\')"',
  'node -e': 'node -e "console.log(\'an owl\')"',
  'python on a worktree script': 'python scripts/count.py',
  'npx of an installed binary': 'npx owls',
  // What must still ask.
  'redirected out of the worktree': 'git status --short > ../status.txt',
  'cd out of the worktree': 'cd .. && ls',
  'npm install of a package': 'npm install factory-test-no-such-package-89',
  'pip install': 'pip install factory-test-no-such-package-89',
} as const;

// Where an L1 call ends up: Claude Code runs it unasked, or it reaches the
// gate, where the factory's matcher lets it through (a rule the operator
// added during the run is matched there too) or the operator is asked.
type Outcome = 'Claude Code allows' | 'factory matcher allows' | 'asks the operator';

test('an L1 run’s allow rules are matched by Claude Code itself, and the gate’s matcher lets through what T8 asked about', async () => {
  const { cwd } = repo();
  const shapes = Object.entries(SHAPES);

  const { asked, ran, reported } = await replay(afkRun(cwd, runEach(Object.values(SHAPES)), 60));

  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'runCompleted']);
  // The agent ran every command as given, so each outcome below is the rules'.
  expect(ran).toEqual(shapes.map(([, command]) => oneLine(command)));
  const outcomes = Object.fromEntries(
    shapes.map(([name, command]): [string, Outcome] => {
      if (!asked.includes(oneLine(command))) return [name, 'Claude Code allows'];
      return [name, covers(FACTORY_ALLOW_LIST, { tool: 'Bash', input: { command } }, cwd) ? 'factory matcher allows' : 'asks the operator'];
    }),
  );
  // The record, as of Agent SDK 0.3.312. Claude Code lets A13 and A14
  // through itself: it splits chains and pipes, and takes `sed -n`, `file -`,
  // `wc`, globs, `2>/dev/null` and a redirect into the worktree as safe. The
  // rest of T8's requests no longer ask the operator (#89). Claude Code
  // matches lockfile installs, inline code and heredocs fed to an
  // interpreter by the factory's rules. What no rule's glob can say, a
  // `git config` key alone, `sed -i` on worktree files, a worktree script or
  // an installed binary, still reaches the gate, whose matcher lets it through.
  expect(outcomes).toEqual({
    'A12 chained reads': 'factory matcher allows',
    'A13 pipes into file, wc and sed': 'Claude Code allows',
    'A14 sed -n and grep reads': 'Claude Code allows',
    'A15 npm ci then vitest': 'Claude Code allows',
    'A16 heredoc into python': 'Claude Code allows',
    'A19 sed -i then tsc': 'factory matcher allows',
    'git config read': 'factory matcher allows',
    'glob read piped into head': 'Claude Code allows',
    'sed -i in the worktree': 'factory matcher allows',
    'allow-listed, with 2>/dev/null': 'Claude Code allows',
    'allow-listed, piped into head': 'Claude Code allows',
    'allow-listed, chained': 'Claude Code allows',
    'allow-listed, redirected into the worktree': 'Claude Code allows',
    'allow-listed only': 'Claude Code allows',
    'allow-listed only, piped and chained': 'Claude Code allows',
    'git config --get': 'Claude Code allows',
    'cd within the worktree': 'Claude Code allows',
    'python -c': 'Claude Code allows',
    'node -e': 'Claude Code allows',
    'python on a worktree script': 'factory matcher allows',
    'npx of an installed binary': 'factory matcher allows',
    'redirected out of the worktree': 'asks the operator',
    'cd out of the worktree': 'asks the operator',
    'npm install of a package': 'asks the operator',
    'pip install': 'asks the operator',
  });
});

test('without the allow rules, a call only they let through reaches the gate', async () => {
  const { cwd } = repo();

  const { asked, ran } = await replay(afkRun(cwd, runEach(['npm test']), 6, []));

  expect(ran).toEqual(['npm test']);
  expect(asked).toEqual(['npm test']);
});

test('a hard deny is refused without asking, even where an allow rule would let it through', async () => {
  const { cwd, origin } = repo();
  // Operator rules that match every git and gh command, hard denies
  // included, beside rules Claude Code drops as invalid.
  const rules = [...FACTORY_ALLOW_LIST, 'Bash(git *)', 'Bash(gh *)', 'Bash()', 'Nonsense(x)'];
  const denied = [
    'git status --short && git push origin HEAD:refs/heads/main',
    'git push origin main',
    // L1 lets inline code through to python and node (#89).
    'python -c "import os; os.system(\'git push origin HEAD:refs/heads/main\')"',
    'node -e "require(\'child_process\').execSync(\'git push origin HEAD:refs/heads/main\')"',
    "sh -c 'git push origin HEAD:refs/heads/main'",
    'git switch -c elsewhere',
    'git worktree list',
    'gh auth status',
  ];

  const start = afkRun(cwd, runEach(denied), 22, rules);
  const { asked, ran, reported } = await replay(start);

  expect(reported.map((event) => event.type)).toEqual(['runStarted', 'runCompleted']);
  expect(ran).toEqual(denied);
  expect(asked).toEqual([]);
  // Nothing reached the remote, and the branch stayed.
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
  expect(git('-C', origin, 'for-each-ref')).toBe('');
  expect(git('-C', cwd, 'branch', '--show-current')).toBe('main');
  // Each call came back to the agent as the factory's refusal.
  const messages = await getSessionMessages(start.sessionId, { dir: cwd });
  const results = messages.flatMap((message) => {
    const content = (message.message as { content?: unknown } | null)?.content;
    return Array.isArray(content) ? content.filter((block) => block?.type === 'tool_result').map((block) => JSON.stringify(block.content)) : [];
  });
  expect(results).toEqual(denied.map(() => expect.stringContaining('the factory pushes for you')));
});
