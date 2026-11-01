// Seam 1: the L1 gate (ADR 0007) through the client protocol. A tool call the
// factory's allow list, the operator's permissions file or the task's rules
// cover runs without asking; anything else raises a permission request that
// suspends its run, answered Allow once, Allow for this task, or Deny with a note.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
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

    operatorRules(factory, 'allow:\n  - Bash(make *)\n');
    factory.executor.askPermission('R1', bash('toolu_1', 'make lint'));
    operatorRules(factory, 'allow:\n  - Bash(make *)\n  - Bash(docker build *)\n');
    factory.executor.askPermission('R1', bash('toolu_2', 'docker build -t widgets .'));
    await settled(operator);

    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true } });
    expect(tui.state().attentionQueue).toEqual([]);
  });
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
        permission: {
          id: 'toolu_1',
          tool: 'Bash',
          summary: 'npm publish',
          rule: 'Bash(npm publish)',
          proposed: [{ part: 'npm publish', rule: 'Bash(npm publish *)' }],
        },
      },
    ]);
    expect(factory.executor.verdicts('R1')).toEqual({});
  });

  test('chained, it names only the parts no rule covers, each with the pattern Allow for this task proposes', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    factory.executor.askPermission('R1', bash('toolu_1', "npm install zod && sed -i 's/a/b/' src/a.ts && npm test && sed -i 's/c/d/' src/b.ts"));

    const state = await tui.until((state) => state.attentionQueue.length === 1);
    expect(state.attentionQueue[0]).toMatchObject({
      reason: "Bash: npm install zod · sed -i 's/a/b/' src/a.ts · sed -i 's/c/d/' src/b.ts",
      permission: {
        rule: "Bash(npm install zod && sed -i 's/a/b/' src/a.ts && npm test && sed -i 's/c/d/' src/b.ts)",
        proposed: [
          { part: 'npm install zod', rule: 'Bash(npm install *)' },
          { part: "sed -i 's/a/b/' src/a.ts", rule: 'Bash(sed -i *)' },
        ],
      },
    });
  });

  test('run by an interpreter, a script proposes a pattern for that script, and inline code only its exact command', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    await tui.until((state) => state.tasks.T1?.label === 'Running');

    factory.executor.askPermission('R1', bash('toolu_1', 'node scripts/seed.js --fresh; python -c "import this"'));

    const state = await tui.until((state) => state.attentionQueue.length === 1);
    expect(state.attentionQueue[0]).toMatchObject({
      permission: {
        proposed: [
          { part: 'node scripts/seed.js --fresh', rule: 'Bash(node scripts/seed.js *)' },
          { part: 'python -c "import this"', rule: 'Bash(python -c "import this")' },
        ],
      },
    });
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
    factory.executor.askPermission('R1', bash('toolu_3', 'echo rm -rf build >nul.sh'));
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
    expect(tui.state().tasks.T1?.allowRules).toEqual(['Bash(npm publish *)']);

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

  test('Allow for this task adds the rules the operator confirms, which then cover like calls, alone or chained, in later runs too', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', "npm test && sed -i 's/a/b/' src/a.ts"));
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task', rules: ['Bash(sed -i *)'] } })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(tui.state().tasks.T1?.allowRules).toEqual(['Bash(sed -i *)']);

    factory.executor.askPermission('R1', bash('toolu_2', "sed -i 's/x/y/' src/b.ts"));
    factory.executor.askPermission('R1', bash('toolu_3', "git status && sed -i -e 's/p/q/' src/c.ts 2>&1 | head -5"));
    factory.executor.report('R1', { type: 'runCompleted' });
    await operator.send({ type: 'requestChanges', taskId: 'T1', comments: 'Tighten it up.' });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    factory.executor.askPermission('R2', bash('toolu_4', "sed -i 's/m/n/' src/d.ts; npm test"));
    await settled(operator);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true }, toolu_3: { allow: true } });
    expect(factory.executor.verdicts('R2')).toEqual({ toolu_4: { allow: true } });

    factory.executor.askPermission('R2', bash('toolu_5', "sed 's/a/b/' src/a.ts > out.ts"));
    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
  });

  test('Allow for this task with no rules adds the ones the request proposes', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', 'npm install zod && npm run build && docker build -t widgets .'));
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task' } });

    const state = await tui.until((state) => state.tasks.T1?.label === 'Running');
    expect(state.tasks.T1?.allowRules).toEqual(['Bash(npm install *)', 'Bash(docker build *)']);
  });

  test('Allow for this task refuses rules that aren’t rules', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', 'npm publish'));
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    const refusal = { ok: false, reason: 'Allow for this task needs at least one rule, each such as `Bash(sed -i *)`.' };
    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task', rules: [] } })).toEqual(refusal);
    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task', rules: ['Bash(npm publish *)', ' '] } })).toEqual(refusal);
    expect(tui.state().tasks.T1?.label).toBe('Needs you');
  });

  test('Allow for this task covers a command that can’t be split exactly', async () => {
    const { factory, operator, tui } = await attached();
    await operator.send(afk('Fix the login bug'));
    factory.executor.askPermission('R1', bash('toolu_1', 'npm ci && npm run build > build.log'));
    await tui.until((state) => state.runs.R1?.status === 'suspended');

    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task' } });
    await tui.until((state) => state.tasks.T1?.label === 'Running');
    factory.executor.askPermission('R1', bash('toolu_2', 'npm ci && npm run build > build.log'));
    await settled(operator);
    expect(factory.executor.verdicts('R1')).toEqual({ toolu_1: { allow: true }, toolu_2: { allow: true } });

    factory.executor.askPermission('R1', bash('toolu_3', 'npm ci && npm run build > /etc/build.log'));
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

  test('Allow once lets through that exact call only, not a like one', async () => {
    const { factory, operator, tui } = await parked();
    await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'once' } });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');

    factory.executor.askPermission('R2', bash('toolu_2', 'npm publish --tag next'));

    await tui.until((state) => state.tasks.T1?.label === 'Needs you');
    expect(factory.executor.verdicts('R2')).toEqual({});
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

  test('Allow for this task opens the next run on it, with its rules on the task', async () => {
    const { factory, operator, tui } = await parked();

    expect(await operator.send({ type: 'answer', taskId: 'T1', permission: { allow: 'task', rules: ['Bash(npm *)'] } })).toEqual({ ok: true });

    const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
    expect(state.tasks.T1?.allowRules).toEqual(['Bash(npm *)']);
    expect(opening(factory)).toBe(
      'While this conversation was parked, the operator allowed Bash: npm publish, and for the rest of this task the calls these rules cover: Bash(npm *).\n\n' +
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
