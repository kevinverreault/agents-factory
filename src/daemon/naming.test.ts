// Seam 1: naming a root task at launch. A small model reads the prompt and
// writes the task's title, its branch slug and a summary; when it fails or
// takes too long, the task is named from the prompt's first line as before,
// and the launch goes on. The PR takes the title the PR body stage wrote,
// and the summary as its body when no stage wrote one.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Namer } from '../naming/task-naming.ts';
import { startTestFactory, type TestFactory } from '../testing/test-factory.ts';
import { watch } from '../testing/watch.ts';

const factories: TestFactory[] = [];

afterEach(async () => {
  for (const factory of factories.splice(0)) await factory.dispose();
});

const clone = resolve('/clones/widgets');
const PROMPT =
  'Improve the task naming, branch naming, and PR description. It should not be taken from a fixed amount of characters from the prompt, ' +
  'the agent should analyze the request and create an appropriate name for the task and branch.\nThe PR description should be a summary.';
const NAME = {
  title: 'Agent-written task and branch names',
  slug: 'agent-written-task-names',
  summary: 'Names tasks, branches and PRs with a model instead of cropping the prompt.',
};

// A namer answering `reply` (or failing as `reply` does), recording what it was asked.
function namer(reply: () => Promise<string>): Namer & { asked: string[] } {
  const asked: string[] = [];
  return { asked, name: (request) => (asked.push(request), reply()) };
}

// A factory, its repository registered, with `stages` as the `unattended` preset.
async function factoryWith(namer: Namer | undefined, stages: string[], more: { namingTimeoutMs?: number } = {}) {
  const factory = await startTestFactory({ ...(namer && { namer }), ...more });
  factories.push(factory);
  mkdirSync(factory.paths.presetsDir, { recursive: true });
  writeFileSync(join(factory.paths.presetsDir, 'unattended.preset.yaml'), ['stages:', ...stages.map((stage) => `  - ${stage}`), ''].join('\n'));
  await factory.registerRepo();
  const operator = await factory.attach();
  return { factory, operator, tui: watch(operator) };
}

const BUILD = '{ id: build, kind: run, mode: AFK, skill: implement, args: "{{prompt}}", exit: run-completed }';
const PR_BODY = '{ id: pr-body, kind: run, mode: AFK, skill: pr, model: haiku, exit: "artifact:pr-body" }';
const OPEN_PR = '{ id: open-pr, kind: action, mode: AFK, requires: L2 }';

describe('naming a task at launch', () => {
  test('the namer’s title, branch slug and summary name the task, from its prompt', async () => {
    const naming = namer(async () => JSON.stringify(NAME));
    const { factory, operator, tui } = await factoryWith(naming, [BUILD]);

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: PROMPT })).toEqual({ ok: true, value: { taskId: 'T1' } });

    const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(naming.asked).toEqual([PROMPT]);
    expect(state.tasks.T1).toMatchObject({ title: NAME.title, branch: 'factory/T1-agent-written-task-names', summary: NAME.summary });
    expect((await factory.git.worktrees(clone)).map(({ branch }) => branch)).toContain('factory/T1-agent-written-task-names');
  });

  test.each([
    ['fails', {}, () => Promise.reject(new Error('The namer is offline.'))],
    ['takes too long', { namingTimeoutMs: 20 }, () => new Promise<string>(() => {})],
    ['answers with nothing usable', {}, async () => 'Sure! Here is a name: logout'],
  ])('when the namer %s, the launch goes on, named from the prompt’s first line', async (_, more, reply) => {
    const { operator, tui } = await factoryWith(namer(reply), [BUILD], more);

    expect(await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: PROMPT })).toEqual({ ok: true, value: { taskId: 'T1' } });

    const state = await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    expect(state.tasks.T1!.title).toBe('Improve the task naming, branch naming, and PR description. It should n…');
    expect(state.tasks.T1).toMatchObject({ branch: 'factory/T1-improve-the-task-naming-branch-naming', summary: null });
  });
});

describe('the PR of a named task', () => {
  async function inReview(stages: string[], prBody?: { body: string; title?: string }) {
    const { factory, operator, tui } = await factoryWith(namer(async () => JSON.stringify(NAME)), stages);
    await operator.send({ type: 'launchTask', repo: 'acme/widgets', preset: 'unattended', prompt: PROMPT });
    await tui.until((state) => state.tasks.T1?.liveRunId === 'R1');
    factory.git.editFile(tui.state().tasks.T1!.worktree!, 'src/naming.ts', 'export {};\n');
    factory.git.commitAll(tui.state().tasks.T1!.worktree!);
    factory.executor.report('R1', { type: 'runCompleted' });
    if (prBody) {
      await tui.until((state) => state.tasks.T1?.liveRunId === 'R2');
      factory.executor.report('R2', { type: 'prBodyWritten', ...prBody });
      factory.executor.report('R2', { type: 'runCompleted' });
    }
    await tui.until((state) => state.tasks.T1?.label === 'In review');
    expect(await operator.send({ type: 'pushAndOpenPr', taskId: 'T1' })).toEqual({ ok: true });
    await tui.until((state) => state.tasks.T1?.pr !== null);
    return factory.github.pullRequests[0]!;
  }

  test('takes the title the PR body stage wrote with its body', async () => {
    const pr = await inReview([BUILD, PR_BODY, OPEN_PR], { body: 'Names tasks with Haiku.', title: 'Name tasks, branches and PRs with a model' });

    expect(pr.title).toBe('Name tasks, branches and PRs with a model');
    expect(pr.body).toMatch(/^Names tasks with Haiku\.\n\n---\n/);
  });

  test('keeps the written title on one line', async () => {
    const pr = await inReview([BUILD, PR_BODY, OPEN_PR], { body: 'Names tasks with Haiku.', title: '  Name tasks,\n  branches and PRs  ' });

    expect(pr.title).toBe('Name tasks, branches and PRs');
  });

  test('takes the task’s title when the PR body stage wrote none', async () => {
    const pr = await inReview([BUILD, PR_BODY, OPEN_PR], { body: 'Names tasks with Haiku.' });

    expect(pr.title).toBe(NAME.title);
  });

  test('without a PR body or a brief, its body is the launch summary, not the cropped title', async () => {
    const pr = await inReview([BUILD, OPEN_PR]);

    expect(pr.title).toBe(NAME.title);
    expect(pr.body).toMatch(new RegExp(`^${NAME.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n---\\n`));
  });
});
