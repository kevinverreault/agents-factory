// The merge gate's configuration (ADR 0014), resolved purely: built-in
// defaults, overridden field by field by the operator's merge-gate.yaml and
// then by that file's section for the task's repository.
import { describe, expect, test } from 'vitest';
import { DEFAULT_MERGE_GATE, resolveMergeGateConfig } from './merge-gate.ts';

const PATH = '/home/op/.agent-factory/merge-gate.yaml';
const file = (content: string) => ({ path: PATH, content });

describe('resolving the merge gate config', () => {
  test('with no file, it is the built-in defaults', () => {
    expect(resolveMergeGateConfig(null, 'acme/widgets')).toEqual({ config: DEFAULT_MERGE_GATE, section: null });
    expect(DEFAULT_MERGE_GATE.mergeMethod).toBe('merge');
    expect(DEFAULT_MERGE_GATE.tripwires.paths).toEqual(expect.arrayContaining(['**/migrations/**', '.github/**', 'docs/adr/**', '**/Dockerfile', '**/*.tf']));
    expect(DEFAULT_MERGE_GATE.tripwires.predicates).toEqual(['dependency-change', 'tests-removed-or-skipped', 'high-severity-finding']);
    expect(DEFAULT_MERGE_GATE.rubric).toHaveLength(5);
    expect(DEFAULT_MERGE_GATE.rubric.join(' ')).not.toMatch(/diff size|lines changed/i);
  });

  test('an empty file is the built-in defaults too', () => {
    expect(resolveMergeGateConfig(file(''), 'acme/widgets')).toEqual({ config: DEFAULT_MERGE_GATE, section: null });
    expect(resolveMergeGateConfig(file('# nothing yet\n'), 'acme/widgets')).toEqual({ config: DEFAULT_MERGE_GATE, section: null });
  });

  test('the user file overrides the defaults field by field, keeping those it leaves out', () => {
    const resolved = resolveMergeGateConfig(file('merge_method: rebase\ntripwires:\n  paths: [infra/**]\n'), 'acme/widgets');
    expect(resolved).toEqual({
      config: { ...DEFAULT_MERGE_GATE, mergeMethod: 'rebase', tripwires: { paths: ['infra/**'], predicates: DEFAULT_MERGE_GATE.tripwires.predicates } },
      section: null,
    });
  });

  test('a repository’s section overrides the user file field by field, and only for that repository', () => {
    const content = [
      'merge_method: rebase',
      'rubric: [It touches billing.]',
      'repositories:',
      '  acme/widgets:',
      '    merge_method: squash',
      '    tripwires:',
      '      predicates: [dependency-change]',
      '  acme/gadgets:',
      '    rubric: []',
    ].join('\n');
    expect(resolveMergeGateConfig(file(content), 'acme/widgets')).toEqual({
      config: {
        mergeMethod: 'squash',
        rubric: ['It touches billing.'],
        tripwires: { paths: DEFAULT_MERGE_GATE.tripwires.paths, predicates: ['dependency-change'] },
      },
      section: 'acme/widgets',
    });
    expect(resolveMergeGateConfig(file(content), 'acme/other')).toEqual({ config: { ...DEFAULT_MERGE_GATE, mergeMethod: 'rebase', rubric: ['It touches billing.'] }, section: null });
    // A repository's name matches whatever its case, as on GitHub.
    expect(resolveMergeGateConfig(file(content), 'Acme/Widgets')).toMatchObject({ config: { mergeMethod: 'squash' }, section: 'acme/widgets' });
    // With no repository, the user file alone.
    expect(resolveMergeGateConfig(file(content), null)).toMatchObject({ config: { mergeMethod: 'rebase' } });
  });

  test('an invalid file is refused with a readable reason naming it', () => {
    const refused = (content: string) => resolveMergeGateConfig(file(content), 'acme/widgets');
    expect(refused('merge_method: fast-forward')).toEqual({
      error: `The merge gate config at ${PATH} is invalid: merge_method must be merge, squash or rebase, not fast-forward.`,
    });
    expect(refused('repositories:\n  acme/widgets:\n    merge_method: ff\n')).toEqual({
      error: `The merge gate config at ${PATH} is invalid: repositories.acme/widgets.merge_method must be merge, squash or rebase, not ff.`,
    });
    expect(refused('tripwires:\n  predicates: [diff-size]\n')).toEqual({
      error: `The merge gate config at ${PATH} is invalid: tripwires.predicates.0 must be dependency-change, tests-removed-or-skipped or high-severity-finding, not diff-size.`,
    });
    expect(refused('rubric: It is risky.')).toEqual({ error: `The merge gate config at ${PATH} is invalid: rubric must be a list of strings.` });
    expect(refused('tripwires:\n  paths: ["  "]\n')).toEqual({ error: `The merge gate config at ${PATH} is invalid: tripwires.paths.0 must not be empty.` });
    expect(refused('merge_mehtod: squash')).toEqual({ error: `The merge gate config at ${PATH} is invalid: merge_mehtod is not a merge gate field (tripwires, rubric, merge_method, repositories).` });
    expect(refused('repositories:\n  widgets:\n    merge_method: squash\n')).toEqual({
      error: `The merge gate config at ${PATH} is invalid: repositories.widgets is not a repository: name it owner/name.`,
    });
    expect(refused('- squash')).toEqual({ error: `The merge gate config at ${PATH} is invalid: it must be a mapping of merge gate fields.` });
    expect(refused('merge_method: [')).toMatchObject({ error: expect.stringMatching(new RegExp(`^The merge gate config at ${PATH} isn’t YAML: `)) });
  });

  test('two sections naming the same repository in different cases are refused', () => {
    expect(resolveMergeGateConfig(file('repositories:\n  acme/widgets: {}\n  Acme/Widgets: {}\n'), null)).toEqual({
      error: `The merge gate config at ${PATH} is invalid: repositories.Acme/Widgets names the same repository as another section, in another case.`,
    });
  });

  test('an invalid section of another repository refuses the file all the same', () => {
    expect(resolveMergeGateConfig(file('repositories:\n  acme/gadgets:\n    merge_method: ff\n'), 'acme/widgets')).toMatchObject({ error: expect.stringContaining('repositories.acme/gadgets.merge_method') });
  });
});
