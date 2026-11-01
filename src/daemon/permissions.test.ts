// Seam 1: the L1 gate (ADR 0007) through the client protocol. An L1 run
// starts with the factory's allow list and the operator's permissions file as
// Claude Code's own rules, so Claude Code lets most calls through itself. A
// call that still reaches the gate is matched again: one the factory's allow
// list, the operator's permissions file or the task's rules cover runs without
// asking; anything else raises a permission request that suspends its run,
// answered Allow once, Allow for this task, or Deny with a note.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FACTORY_ALLOW_LIST } from '../permissions/permissions.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch, type Watched } from '../testing/watch.ts';

const factories: TestFactory[] = [];

async function attached(): Promise<{ factory: TestFactory; operator: FactoryConnection; tui: Watched }> {
  const factory = await startTestFactory();
  factories.push(factory);
  await factory.registerRepo();
  const operator = await factory.attach();
  const tui = watch(operator);
  await tui.until(() => true);
  return { factory, operator, tui };
}

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const afk = (title: string) => ({ type: 'createTask', repo: 'acme/widgets', title, mode: 'AFK', submit: true }) as const;

// Resolves once every change sent before it has gone through the daemon.
async function settled(connection: FactoryConnection): Promise<void> {
  await connection.send({ type: 'daemon.status' });
}

const bash = (id: string, command: string) => ({ id, tool: 'Bash', input: { command } });

describe('the rules an L1 run starts with', () => {
  test('are the factory’s allow list and the operator’s permissions file, for Claude Code to match itself', async () => {
    const { factory, operator, tui } = await attached();
    operatorRules(factory, 'allow:\n  - Bash(make *)\n  - WebFetch(domain:docs.example.com)\n');

    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    expect(factory.executor.started[0]?.allowRules).toEqual([...FACTORY_ALLOW_LIST, 'Bash(make *)', 'WebFetch(domain:docs.example.com)']);
  });

  test('are the factory’s allow list alone when the permissions file is invalid', async () => {
    const { factory, operator, tui } = await attached();
    operatorRules(factory, 'allow: Bash(make *)\n');

    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    expect(factory.executor.started[0]?.allowRules).toEqual(FACTORY_ALLOW_LIST);
  });
});

describe('a tool call the rules cover', () => {
  test('on the factory’s allow list, it runs without asking the operator', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    factory.executor.askPermission('R1', bash('toolu_1', 'npm test'));
    factory.executor.askPermission('R1', bash('toolu_2', 'git add src/login.ts && git commit -m "Fix the login bug"'));
    factory.executor.askPermission('R1', { id: 'toolu_3', tool: 'WebFetch', input: { url: 'https://docs.example.com/sso' } });
    factory.executor.askPermission('R1', bash('toolu_4', 'gh issue view 47 --repo acme/widgets --comments; git log --oneline | head -5; git status --short'));
    await settled(operator);

    expect(factory.executor.verdicts('R1')).toEqual({
      toolu_1: { allow: true },
      toolu_2: { allow: true },
      toolu_3: { allow: true },
      toolu_4: { allow: true },
    });
    expect(tui.state().tasks.T1?.label).toBe('Running');
    expect(tui.state().attentionQueue).toEqual([]);
  });

  test('in the operator’s permissions file, it runs without asking, read afresh for every call', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    // Added while the run is under way, so not among the rules it started with.
    operatorRules(factory, 'allow:\n  - Bash(make *)\n');
    factory.executor.askPermission('R1', bash('toolu_1', 'make lint'));
    operatorRules(factory, 'allow:\n  - Bash(make *)\n  - Bash(docker build *)\n');
    factory.executor.askPermission('R1', bash('toolu_2', 'docker build -t widgets .'));
    await settled(operator);

    expect(factory.executor.started[0]?.allowRules).toEqual(FACTORY_ALLOW_LIST);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true } });
    expect(tui.state().attentionQueue).toEqual([]);
  });
});

// What AFK runs reach for (#89): the calls Claude Code still asks about, which
// the factory's own matcher lets through by what they do.
describe('a call AFK runs reach for, which Claude Code still asks about', () => {
  // Whether the gate lets each command through without asking, in the run's
  // worktree, which `prepare` may fill first.
  async function gated(
    commands: readonly string[] | ((worktree: string) => readonly string[]),
    prepare: (worktree: string) => void = () => {},
  ): Promise<boolean[]> {
    const { factory, operator, tui } = await attached();
    // A launched AFK task runs guarded, in its own worktree.
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'implement', prompt: '#39' });
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    const worktree = factory.executor.started[0]!.cwd!;
    prepare(worktree);
    const asked = typeof commands === 'function' ? commands(worktree) : commands;
    asked.forEach((command, index) => factory.executor.askPermission('R1', bash(`toolu_${index}`, command)));
    await settled(operator);
    const verdicts = factory.executor.verdicts('R1');
    return asked.map((_, index) => verdicts[`toolu_${index}`]?.allow === true);
  }

  // The worktree as Git Bash names it, with `/d/` for `D:\`.
  const bashPath = (path: string) => path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');

  test.each([
    'git config core.autocrlf; cat .gitattributes 2>/dev/null; git diff notes.txt | head -5; ls; cat *.md 2>/dev/null | head -80',
    'git config --get user.name',
    'git config --list --show-origin',
    'git config get core.autocrlf',
  ])('a git config read runs without asking: `%s`', async (command) => {
    expect(await gated([command])).toEqual([true]);
  });

  test.each(['git config core.autocrlf false', 'git config --unset core.autocrlf', 'git config set core.autocrlf false'])(
    'a git config write still asks: `%s`',
    async (command) => {
      expect(await gated([command])).toEqual([false]);
    },
  );

  test('redirected into the worktree, or after a `cd` within it, it runs without asking', async () => {
    const commands = (worktree: string) => [
      'git config core.autocrlf > autocrlf.txt',
      'git config core.autocrlf >> logs/config.log 2>&1',
      `git config core.autocrlf > ${join(worktree, 'autocrlf.txt')}`,
      `git config core.autocrlf > ${bashPath(worktree)}/autocrlf.txt`,
      'cd src && git config core.autocrlf > ../autocrlf.txt',
      `cd ${bashPath(worktree)}/src; git config core.autocrlf`,
      'cat > notes.md <<EOF\nan owl > a heron\nEOF',
    ];
    expect(await gated(commands)).toEqual([true, true, true, true, true, true, true]);
  });

  test.each([
    'git config core.autocrlf > ../autocrlf.txt',
    'git config core.autocrlf > /tmp/autocrlf.txt',
    'git config core.autocrlf > ~/autocrlf.txt',
    'git config core.autocrlf > $HOME/autocrlf.txt',
    'git config core.autocrlf > .git/hooks/pre-commit',
    'cd src && git config core.autocrlf > ../../autocrlf.txt',
    'cd .. && git config core.autocrlf',
    'cd && git status',
    'cd /tmp; ls',
  ])('redirected or moved out of the worktree, it still asks: `%s`', async (command) => {
    expect(await gated([command])).toEqual([false]);
  });

  test('installs from the lockfile, and npx of a binary the project installed, run without asking', async () => {
    const commands = [
      'npm ci 2>&1 | tail -5; npx vitest run 2>&1 | tail -30',
      'npm ci --ignore-scripts',
      'pnpm install --frozen-lockfile',
      'yarn install --immutable',
      'npx prettier --check .',
      'cd packages/web && npx astro build',
    ];
    const installed = (worktree: string) => {
      for (const [dir, bin] of [
        ['.', 'prettier'],
        ['packages/web', 'astro'],
      ]) {
        mkdirSync(join(worktree, dir!, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(join(worktree, dir!, 'node_modules', '.bin', bin!), '');
      }
    };
    expect(await gated(commands, installed)).toEqual([true, true, true, true, true, true]);
  });

  test.each([
    'npm install left-pad',
    'npm install',
    'npm i -D left-pad',
    'pnpm add left-pad',
    'yarn add left-pad',
    'pip install requests',
    'python -m pip install requests',
    'npx prettier --check .',
    'npx --yes prettier --check .',
    'npx -p left-pad prettier',
  ])('an install the lockfile doesn’t pin still asks: `%s`', async (command) => {
    expect(await gated([command])).toEqual([false]);
  });

  test('sed, reading anywhere or editing worktree files in place, runs without asking', async () => {
    const commands = [
      'sed -i "s/a heron/a grey heron/" notes.txt && npx tsc --noEmit 2>&1 | head',
      "sed -i.bak -e 's/owl/heron/' -e 's/cat/dog/' src/a.ts src/b.ts",
      "sed -ni '/owl/p' notes.txt",
      "cd src && sed --in-place 's/owl/heron/' login.ts",
      "sed -n '1,200p' notes.txt",
      "sed 's/owl/heron/' ../elsewhere/notes.txt",
    ];
    expect(await gated(commands)).toEqual([true, true, true, true, true, true]);
  });

  test.each([
    "sed -i 's/owl/heron/' ../elsewhere/notes.txt",
    "sed -i 's/owl/heron/' /etc/hosts",
    "sed -i 's/owl/heron/' notes.txt .git/config",
    "sed -ie 's/owl/heron/' ~/notes.txt",
    "sed -i 's/owl/heron/'",
  ])('sed editing outside the worktree still asks: `%s`', async (command) => {
    expect(await gated([command])).toEqual([false]);
  });

  test('python and node, on a worktree script, inline code or a heredoc, run without asking', async () => {
    const commands = [
      "python - <<'EOF'\np='notes.txt'\ns=open(p).read()\nopen(p,'w').write(s.replace('an owl again','an owl, again'))\nEOF",
      'python3 -c "import json; print(json.load(open(\'package.json\'))[\'name\'])"',
      'python -u scripts/generate.py --out build',
      "node -e \"console.log(require('./package.json').name)\"",
      "node --eval 'console.log(1)' && node -p 1+1",
      'node scripts/build.mjs > build.log',
      "node <<'EOF'\nconsole.log('an owl');\nEOF",
      'cd scripts && py generate.py',
    ];
    expect(await gated(commands)).toEqual([true, true, true, true, true, true, true, true]);
  });

  test.each(['python ../elsewhere/generate.py', 'python /tmp/generate.py', 'node ~/build.js', 'python', 'python -m http.server', 'node --require ./hook.js build.js'])(
    'an interpreter on anything else still asks: `%s`',
    async (command) => {
      expect(await gated([command])).toEqual([false]);
    },
  );
});

describe('a tool call no rule covers', () => {
  test('raises a permission request that suspends its run and frees its slot, saying what the call is', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Fix the login bug'));
    await operator.send(afk('Add dark mode'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    factory.executor.askPermission('R1', bash('toolu_1', 'npm publish'));

    const state = await tui.until((state) => state.tasks.T2?.label === 'Running');
    expect(state.tasks.T1?.label).toBe('Needs you');
    expect(state.runs.R1?.status).toBe('suspended');
    expect(state.slots).toEqual({ active: 1, cap: 1 });
    expect(state.attentionQueue).toEqual([
      {
        kind: 'attention',
        taskId: 'T1',
        repo: 'acme/widgets',
        requestId: 'A1',
        attention: 'permission',
        holdsRun: true,
        reason: 'Bash: npm publish',
        question: null,
        permission: { id: 'toolu_1', tool: 'Bash', summary: 'npm publish', rule: 'Bash(npm publish)' },
      },
    ]);
    expect(factory.executor.verdicts('R1')).toEqual({});
  });

  test('a permissions file that can’t be read grants nothing, and the request says why', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    operatorRules(factory, 'allow: Bash(make *)\n');
    factory.executor.askPermission('R1', bash('toolu_1', 'make lint'));

    const state = await tui.until((state) => state.attentionQueue.length === 1);
    expect(state.attentionQueue[0]?.kind === 'attention' && state.attentionQueue[0].reason).toBe(
      `Bash: make lint (${factory.paths.permissionsPath} must hold \`allow:\`, a list of rules such as \`Bash(make *)\`, so its rules granted nothing.)`,
    );
  });

  test('chained, backgrounded or redirected, a command is covered only when every part is', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    factory.executor.askPermission('R1', bash('toolu_1', 'npm test 2>&1 && git status'));
    factory.executor.askPermission('R1', bash('toolu_2', 'ls & rm -rf build'));
    factory.executor.askPermission('R1', bash('toolu_3', 'echo rm -rf build >../nul.sh'));
    await settled(operator);

    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true } });
    expect(rows(await tui.until((state) => state.attentionQueue.length === 1))).toEqual(['T1 permission']);
  });

  test('raised while another request holds the run, it waits for that one’s answer, then is asked about in turn', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', 'npm publish'));
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    factory.executor.askPermission('R1', bash('toolu_2', 'docker build .'));
    factory.executor.askPermission('R1', bash('toolu_3', 'npm test'));
    await settled(operator);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_3: { allow: true } });
    expect(tui.state().attentionQueue).toHaveLength(1);

    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } });

    const state = await tui.until((state) => state.attentionQueue.length === 1 && state.runs.R1?.status === 'suspended');
    expect(state.attentionQueue).toMatchObject([{ requestId: 'A2', reason: 'Bash: docker build .' }]);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_3: { allow: true } });
  });
});

describe('answering a permission request', () => {
  async function asked() {
    const attachedFactory = await attached();
    const { factory, operator, tui } = attachedFactory;
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', 'npm publish'));
    await tui.until((state) => state.runs.R1?.status === 'suspended');
    return attachedFactory;
  }

  test('needs an allow or a deny with a note', async () => {
    const { operator } = await asked();
    const refusal = 'Allow it once, allow it for this task, or deny it with a note for the agent.';
    expect(await operator.send({ type: 'answer', taskId: 'T1' })).toEqual({ ok: false, reason: refusal });
    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { deny: '  ' } })).toEqual({ ok: false, reason: refusal });
  });

  test('Allow once lets that call through and resumes the run at once; the same call later asks again', async () => {
    const { factory, operator, tui } = await asked();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.runs.R1?.status).toBe('active');
    expect(state.attentionQueue).toEqual([]);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true } });

    factory.executor.askPermission('R1', bash('toolu_2', 'npm publish'));
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true } });
  });

  test('Allow for this task stops further prompts for that call on the task, in later runs too, and only on it', async () => {
    const { factory, operator, tui } = await asked();
    await operator.send(afk('Add dark mode'));

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task' } })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(tui.state().tasks.T1?.allowRules).toEqual(['Bash(npm publish)']);

    factory.executor.askPermission('R1', bash('toolu_2', 'npm publish'));
    factory.executor.report('R1', { type: 'runCompleted' });
    await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Tighten it up.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    factory.executor.askPermission('R3', bash('toolu_3', 'npm publish'));
    factory.executor.askPermission('R2', bash('toolu_4', 'npm publish'));
    await settled(operator);

    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true } });
    expect(factory.executor.verdicts('R3')).toEqual({ toolu_3: { allow: true } });
    expect(factory.executor.verdicts('R2')).toEqual({});
    expect(rows(tui.state())).toEqual(['T2 permission']);
  });

  test('Allow for this task covers exactly that call, however it is chained', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', 'npm install && npm run build > build.log'));
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task' } });
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    factory.executor.askPermission('R1', bash('toolu_2', 'npm install && npm run build > build.log'));
    await settled(operator);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true } });

    factory.executor.askPermission('R1', bash('toolu_3', 'npm install && npm run build > /etc/build.log'));
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
  });

  test('Deny delivers the note to the agent and resumes the run', async () => {
    const { factory, operator, tui } = await asked();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { deny: 'Publishing is the release job’s.' } })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(factory.executor.verdicts('R1')).toEqual({
      toolu_1: { allow: false, message: 'The operator denied this: Publishing is the release job’s.' },
    });
    expect(tui.state().tasks.T1?.allowRules).toEqual([]);
  });
});

describe('answering a permission request whose run parked', () => {
  async function parked() {
    const attachedFactory = await attached();
    const { factory, operator, tui } = attachedFactory;
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', 'npm publish'));
    await settled(operator);
    factory.clock.advance(61 * 60_000);
    await tui.until((state) => state.runs.R1?.outcome === 'parked');
    return attachedFactory;
  }

  const opening = (factory: TestFactory) => factory.executor.started.at(-1)?.firstMessage;

  test('Allow once opens the next run on it, and lets that call through once there', async () => {
    const { factory, operator, tui } = await parked();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } })).toEqual({ ok: true });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(opening(factory)).toBe(
      'While this conversation was parked, the operator allowed Bash once: npm publish. Make that call again now.\n\n' +
        'Carry on, unattended, from where this conversation left off.',
    );
    factory.executor.askPermission('R2', bash('toolu_2', 'npm publish'));
    await settled(operator);
    expect(factory.executor.verdicts('R2')).toEqual({ toolu_2: { allow: true } });
    factory.executor.askPermission('R2', bash('toolu_3', 'npm publish'));
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
  });

  test('Allow once is the next run’s only: a later run that makes the call asks again', async () => {
    const { factory, operator, tui } = await parked();
    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    factory.executor.report('R2', { type: 'runCompleted' });
    await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Tighten it up.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R3');
    factory.executor.askPermission('R3', bash('toolu_2', 'npm publish'));

    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(factory.executor.verdicts('R3')).toEqual({});
  });

  test('taken over before its next run starts, the task opens its conversation on the operator’s turn, not on the answer', async () => {
    const { factory, operator, tui } = await parked();
    await operator.send({ type: 'setSlotCap', cap: 1 });
    await operator.send(afk('Add dark mode'));
    await tui.until((state) => state.tasks.T2?.label === 'Running');
    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } });
    await tui.until((state) => state.tasks.T1?.label === 'Queued');

    expect(await operator.send({ type: 'takeOver', taskId: 'T1' })).toEqual({ ok: true });

    const taken = await tui.until((state) => state.tasks.T1?.mode === 'HITL' && state.tasks.T1.liveRunId !== null);
    expect(factory.executor.started.find((run) => run.runId === taken.tasks.T1!.liveRunId)).toMatchObject({ mode: 'HITL', firstMessage: null });
  });

  test('Allow for this task opens the next run on it, with the rule on the task', async () => {
    const { factory, operator, tui } = await parked();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task' } })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(state.tasks.T1?.allowRules).toEqual(['Bash(npm publish)']);
    expect(opening(factory)).toBe(
      'While this conversation was parked, the operator allowed Bash for the rest of this task: npm publish.\n\n' +
        'Carry on, unattended, from where this conversation left off.',
    );
  });

  test('Deny opens the next run on the note', async () => {
    const { factory, operator, tui } = await parked();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { deny: 'Publishing is the release job’s.' } })).toEqual({
      ok: true,
    });

    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(opening(factory)).toBe(
      'While this conversation was parked, the operator denied Bash: npm publish. Their note: Publishing is the release job’s.\n\n' +
        'Carry on, unattended, from where this conversation left off.',
    );
    expect(factory.executor.permitted).toEqual([]);
  });
});

const rows = (state: ReturnType<Watched['state']>) =>
  state.attentionQueue.map((item) => `${item.taskId} ${item.kind === 'attention' ? item.attention : item.kind}`);

function operatorRules(factory: TestFactory, yaml: string): void {
  mkdirSync(dirname(factory.paths.permissionsPath), { recursive: true });
  writeFileSync(factory.paths.permissionsPath, yaml);
}
