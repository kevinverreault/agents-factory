// Preset resolution and schema validation: pure, so tested directly.
import { describe, expect, test } from 'vitest';
import { builtInPresets, issueRefs, openingMessage, resolvePreset, startStages, type PresetFile } from './presets.ts';

const user = (name: string, content: string): PresetFile => ({ scope: 'user', name, path: `~/.agent-factory/presets/${name}.preset.yaml`, content });
const repo = (name: string, content: string): PresetFile => ({ scope: 'repo', name, path: `.agent-factory/presets/${name}.preset.yaml`, content });

function resolved(files: PresetFile[], name: string) {
  const result = resolvePreset([...builtInPresets(), ...files], name);
  if ('error' in result) throw new Error(result.error);
  return result.preset;
}

function refusal(files: PresetFile[], name: string): string {
  const result = resolvePreset([...builtInPresets(), ...files], name);
  if (!('error' in result)) throw new Error(`${name} resolved`);
  return result.error;
}

describe('built-in presets', () => {
  test('main-flow grills, specs and tickets HITL on opus, then implements, reviews and opens a PR AFK', () => {
    const preset = resolved([], 'main-flow');

    expect(preset).toMatchObject({ name: 'main-flow', source: 'built-in' });
    expect(preset.stages.map(({ id, kind, skill, mode, model }) => [id, kind, skill ?? null, mode, model ?? null])).toEqual([
      ['grill', 'run', 'grill-with-docs', 'HITL', 'opus'],
      ['spec', 'run', 'to-spec', 'HITL', 'opus'],
      ['tickets', 'run', 'to-tickets', 'HITL', 'opus'],
      ['implement', 'loop', 'implement', 'AFK', 'sonnet'],
      ['review', 'run', 'code-review', 'AFK', 'sonnet'],
      ['pr-body', 'run', 'pr', 'AFK', 'haiku'],
      ['open-pr', 'action', null, 'AFK', null],
    ]);
    expect(preset.stages.find((stage) => stage.id === 'implement')).toMatchObject({ exit: 'tickets-closed' });
    expect(preset.stages.find((stage) => stage.id === 'review')).toMatchObject({ on_findings: 'fix-once' });
    expect(preset.stages.find((stage) => stage.id === 'open-pr')).toMatchObject({ requires: 'L2' });
  });

  test('wayfinder charts and works a map, then carries on as main-flow from a spec written fresh from the map', () => {
    const preset = resolved([], 'wayfinder');

    expect(preset.stages.map((stage) => stage.id)).toEqual(['chart', 'work', 'spec', 'tickets', 'implement', 'review', 'pr-body', 'open-pr']);
    expect(preset.stages.find((stage) => stage.id === 'spec')).toEqual({
      id: 'spec',
      kind: 'run',
      skill: 'to-spec',
      args: '{{artifacts.map}}',
      mode: 'HITL',
      model: 'opus',
      context: 'fresh',
      exit: 'artifact:spec',
    });
  });

  test('implement runs the implement skill on the prompt AFK, then reviews and opens a PR as quick does', () => {
    const preset = resolved([], 'implement');

    expect(preset.stages.map((stage) => stage.id)).toEqual(['implement', 'review', 'pr-body', 'open-pr']);
    expect(preset.stages[0]).toEqual({
      id: 'implement',
      kind: 'run',
      skill: 'implement',
      args: '{{prompt}}',
      mode: 'AFK',
      model: 'sonnet',
      exit: 'run-completed',
    });
    expect(preset.stages.at(-1)).toMatchObject({ id: 'open-pr', kind: 'action', requires: 'L2' });
    expect(startStages(preset)).toEqual([{ id: 'implement', mode: 'AFK', model: 'sonnet', needs: ['prompt'] }]);
    expect(openingMessage(preset.stages[0]!, { prompt: 'Add a dark mode toggle.', issues: [] })).toBe('/factory:implement Add a dark mode toggle.');
  });

  test('quick, child and setup resolve too', () => {
    expect(resolved([], 'quick').stages.map((stage) => stage.id)).toEqual(['grill', 'implement', 'review', 'pr-body', 'open-pr']);
    expect(resolved([], 'child').stages).toEqual([{ id: 'work', kind: 'run', args: '{{prompt}}', mode: 'AFK', model: 'sonnet', exit: 'run-completed' }]);
    expect(resolved([], 'setup').stages).toMatchObject([{ id: 'setup', mode: 'HITL' }]);
  });
});

const tiny = (skill: string) => `stages:\n  - { id: only, kind: run, skill: ${skill}, mode: HITL }\n`;

describe('scopes', () => {
  test('a repo preset wins over a user preset of the same name, which wins over the built-in', () => {
    expect(resolved([user('main-flow', tiny('mine'))], 'main-flow')).toMatchObject({ source: 'user', stages: [{ skill: 'mine' }] });
    expect(resolved([user('main-flow', tiny('mine')), repo('main-flow', tiny('theirs'))], 'main-flow')).toMatchObject({
      source: 'repo',
      path: '.agent-factory/presets/main-flow.preset.yaml',
      stages: [{ skill: 'theirs' }],
    });
  });

  test('an unknown preset is refused', () => {
    expect(refusal([], 'nightly')).toBe('There is no preset nightly.');
  });
});

describe('extends', () => {
  test('a preset extending another overrides single stages by id, field by field, and inserts new ones where they stand', () => {
    const variant = [
      'extends: main-flow',
      'stages:',
      '  - { id: implement, model: opus, max_turns: 80 }',
      '  - { id: lint, kind: run, skill: lint, mode: AFK }',
      '  - { id: review }',
      '  - { id: changelog, kind: run, skill: changelog, mode: AFK }',
    ].join('\n');

    const preset = resolved([user('careful', variant)], 'careful');

    expect(preset.stages.map((stage) => stage.id)).toEqual(['grill', 'spec', 'tickets', 'implement', 'lint', 'review', 'pr-body', 'open-pr', 'changelog']);
    expect(preset.stages.find((stage) => stage.id === 'implement')).toEqual({
      id: 'implement',
      kind: 'loop',
      skill: 'implement',
      args: '{{artifacts.tickets}}',
      mode: 'AFK',
      model: 'opus',
      max_turns: 80,
      context: 'fresh',
      exit: 'tickets-closed',
    });
  });

  test('a preset extending its own name extends the one it shadows, and other presets extend the winner', () => {
    const tweaked = ['extends: main-flow', 'stages:', '  - { id: grill, model: sonnet }'].join('\n');

    const files = [repo('main-flow', tweaked)];

    expect(resolved(files, 'main-flow')).toMatchObject({ source: 'repo' });
    expect(resolved(files, 'main-flow').stages[0]).toMatchObject({ id: 'grill', skill: 'grill-with-docs', model: 'sonnet' });
    expect(resolved(files, 'main-flow').stages).toHaveLength(7);
    // wayfinder (built-in) extends main-flow, the repo's now.
    expect(resolved(files, 'wayfinder').stages.find((stage) => stage.id === 'spec')).toMatchObject({ args: '{{artifacts.map}}' });
  });

  test('extending a preset that doesn’t exist, from a stage it lacks, or in a cycle is refused', () => {
    expect(refusal([user('a', 'extends: nowhere')], 'a')).toBe('Preset a (user, ~/.agent-factory/presets/a.preset.yaml): it extends nowhere, and there is no preset nowhere.');
    expect(refusal([user('a', 'extends: main-flow\nfrom: deploy')], 'a')).toBe(
      'Preset a (user, ~/.agent-factory/presets/a.preset.yaml): it extends main-flow from deploy, which main-flow has no stage of.',
    );
    expect(refusal([user('a', 'extends: b'), user('b', 'extends: a')], 'a')).toBe('Preset a (user, ~/.agent-factory/presets/a.preset.yaml): it extends itself through b.');
  });
});

describe('the schema', () => {
  const at = 'Preset nightly (user, ~/.agent-factory/presets/nightly.preset.yaml)';
  const nightly = (...stages: string[]) => [user('nightly', ['stages:', ...stages.map((stage) => `  - ${stage}`)].join('\n'))];

  test('an unknown exit condition, or an artifact kind outside the vocabulary, is refused with the vocabulary', () => {
    expect(refusal(nightly('{ id: implement, kind: loop, skill: implement, mode: AFK, exit: tickets-done }'), 'nightly')).toBe(
      `${at}: stage implement: exit tickets-done is not an exit condition (run-completed, artifact:<kind>, tickets-closed, map-cleared).`,
    );
    expect(refusal(nightly('{ id: draw, kind: run, skill: draw, mode: HITL, exit: "artifact:diagram" }'), 'nightly')).toBe(
      `${at}: stage draw: exit artifact:diagram names no artifact kind (map, spec, tickets, pr-body).`,
    );
  });

  test('a field outside the schema, a missing or wrong value, or a template outside the vocabulary is refused', () => {
    expect(refusal(nightly('{ id: implement, kind: run, skill: implement, mode: AFK, budget: 50000 }'), 'nightly')).toBe(
      `${at}: stage implement: budget is not a stage field.`,
    );
    expect(refusal(nightly('{ id: implement, kind: run, skill: implement }'), 'nightly')).toBe(`${at}: stage implement: mode is missing.`);
    expect(refusal(nightly('{ id: implement, kind: run, skill: implement, mode: afk }'), 'nightly')).toBe(
      `${at}: stage implement: mode must be HITL or AFK.`,
    );
    expect(refusal(nightly('{ id: implement, kind: run, skill: implement, mode: AFK, max_turns: 0 }'), 'nightly')).toBe(
      `${at}: stage implement: max_turns must be a whole number of at least 1.`,
    );
    expect(refusal(nightly('{ id: implement, kind: run, skill: implement, mode: AFK, args: "{{artifacts.plan}}" }'), 'nightly')).toBe(
      `${at}: stage implement: args use {{artifacts.plan}}, which is not {{prompt}} or {{artifacts.<kind>}} of map, spec, tickets, pr-body.`,
    );
    expect(refusal([user('nightly', 'stages: []')], 'nightly')).toBe(`${at}: a preset needs at least one stage.`);
    expect(refusal([user('nightly', 'name: nightly\nstages: []')], 'nightly')).toBe(`${at}: name is not a preset field.`);
    expect(refusal([user('nightly', 'stages: [ {')], 'nightly')).toMatch(new RegExp(`^${at.replace(/[().]/g, '\\$&')} isn't YAML: `));
  });

  test('stage ids are unique, actions are factory actions with no skill, and only AFK stages have an autonomy ceiling', () => {
    expect(refusal(nightly('{ id: a, kind: run, skill: x, mode: HITL }', '{ id: a, kind: run, skill: y, mode: HITL }'), 'nightly')).toBe(
      `${at}: stage a appears twice.`,
    );
    expect(refusal(nightly('{ id: deploy, kind: action, mode: AFK }'), 'nightly')).toBe(
      `${at}: stage deploy: an action stage's id names its factory action (open-pr, close-ticket, push).`,
    );
    expect(refusal(nightly('{ id: push, kind: action, skill: push, mode: AFK }'), 'nightly')).toBe(
      `${at}: stage push: an action stage runs no skill.`,
    );
    expect(refusal(nightly('{ id: implement, kind: loop, mode: AFK }'), 'nightly')).toBe(`${at}: stage implement: a loop stage needs a skill.`);
    expect(refusal(nightly('{ id: grill, kind: run, skill: grill-me, mode: HITL, autonomy: L1 }'), 'nightly')).toBe(
      `${at}: stage grill: only an AFK stage has an autonomy ceiling.`,
    );
  });

  test('a stage made whole by overrides is checked whole, and an override of a broken parent reports the parent', () => {
    expect(refusal([user('nightly', 'extends: main-flow\nstages:\n  - { id: lint, kind: run, skill: lint }')], 'nightly')).toBe(
      `${at}: stage lint: mode is missing.`,
    );
    expect(refusal([user('nightly', 'extends: main-flow'), user('main-flow', 'stages: 3')], 'nightly')).toBe(
      'Preset main-flow (user, ~/.agent-factory/presets/main-flow.preset.yaml): stages must be a list of stages.',
    );
  });
});

describe('freezing', () => {
  test('a resolved preset carries a hash of its content, which changes only with its stages', () => {
    const { hash } = resolved([], 'main-flow');
    const tweaked = resolved([user('main-flow', 'extends: main-flow\nstages:\n  - { id: grill, model: sonnet }')], 'main-flow');
    const same = resolved([user('main-flow', 'extends: main-flow\n# Nothing changed.\n')], 'main-flow');

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(tweaked.hash).not.toBe(hash);
    expect(same.hash).toBe(hash);
  });
});

describe('starting at a stage', () => {
  test('a stage can start a task when the launch inputs can fill its args: the prompt, or issue refs standing for issue artifacts', () => {
    expect(startStages(resolved([], 'main-flow'))).toEqual([
      { id: 'grill', mode: 'HITL', model: 'opus', needs: ['prompt'] },
      { id: 'tickets', mode: 'HITL', model: 'opus', needs: ['issues'] },
      { id: 'implement', mode: 'AFK', model: 'sonnet', needs: ['issues'] },
    ]);
    expect(startStages(resolved([], 'wayfinder')).map((stage) => stage.id)).toEqual(['chart', 'work', 'spec', 'tickets', 'implement']);
    // The first stage starts a task even when it needs no input.
    expect(startStages(resolved([], 'setup'))).toEqual([{ id: 'setup', mode: 'HITL', model: 'sonnet', needs: [] }]);
  });

  test('a stage with args needing an artifact no launch input stands for is never a start stage', () => {
    const preset = resolved(
      [user('ship', 'stages:\n  - { id: grill, kind: run, skill: grill-me, args: "{{prompt}}", mode: HITL }\n  - { id: body, kind: run, skill: pr, args: "{{artifacts.pr-body}} {{prompt}}", mode: AFK }')],
      'ship',
    );

    expect(startStages(preset).map((stage) => stage.id)).toEqual(['grill']);
  });

  test('a start stage opens its first run invoking its skill from the factory plugin on the launch inputs', () => {
    const mainFlow = resolved([], 'main-flow');
    const stage = (id: string) => mainFlow.stages.find((stage) => stage.id === id)!;

    expect(openingMessage(stage('grill'), { prompt: 'Grill me about the login flow.', issues: [] })).toBe('/factory:grill-with-docs Grill me about the login flow.');
    expect(openingMessage(stage('implement'), { prompt: '', issues: ['acme/widgets#12', 'acme/widgets#13'] })).toBe(
      '/factory:implement acme/widgets#12 acme/widgets#13',
    );
    expect(openingMessage(resolved([], 'setup').stages[0]!, { prompt: '', issues: [] })).toBe('/factory:setup-matt-pocock-skills');
    // A run with no skill sends its args as they are.
    expect(openingMessage(resolved([], 'child').stages[0]!, { prompt: 'Bump the lockfile.', issues: [] })).toBe('Bump the lockfile.');
  });

  test('issue refs are read as owner/name#n, a bare #n in the task’s repository, or an issue URL', () => {
    expect(issueRefs(['#12', 'acme/gadgets#3', 'https://github.com/acme/widgets/issues/7'], 'acme/widgets')).toEqual({
      issues: ['acme/widgets#12', 'acme/gadgets#3', 'acme/widgets#7'],
    });
    expect(issueRefs(['#12', 'twelve'], 'acme/widgets')).toEqual({ error: 'twelve is not an issue ref (#12, owner/name#12 or an issue URL).' });
  });
});
