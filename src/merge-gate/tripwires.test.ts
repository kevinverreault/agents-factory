// Pure: a semi-auto gate check's tripwires (ADR 0014), evaluated without a
// model over what the factory's own commits changed and the findings the
// review left over, against the task's frozen config.
import { describe, expect, test } from 'vitest';
import { DEFAULT_MERGE_GATE } from './merge-gate.ts';
import { evaluateTripwires, tripwireReason, type ChangedFile } from './tripwires.ts';

const DEFAULTS = DEFAULT_MERGE_GATE.tripwires;

const modified = (path: string, added: string[] = [], removed: string[] = []): ChangedFile => ({ path, status: 'modified', added, removed });
const added = (path: string, lines: string[] = []): ChangedFile => ({ path, status: 'added', added: lines, removed: [] });
const deleted = (path: string, lines: string[] = []): ChangedFile => ({ path, status: 'deleted', added: [], removed: lines });

const fired = (files: ChangedFile[], highFindings: string[] = [], tripwires = DEFAULTS) => evaluateTripwires(tripwires, { files, highFindings });

describe('tripwires', () => {
  test('ordinary source changes trip nothing', () => {
    expect(fired([modified('src/login.ts', ['export const x = 1;']), added('src/logout.ts', ['export {};'])])).toBeNull();
  });

  describe('paths', () => {
    test.each([
      ['db/migrations/0002_users.sql', '**/migrations/**'],
      ['migrations/0001.sql', '**/migrations/**'],
      ['.github/workflows/ci.yml', '.github/**'],
      ['docs/adr/0015-something.md', 'docs/adr/**'],
      ['Dockerfile', '**/Dockerfile'],
      ['deploy/Dockerfile.prod', '**/Dockerfile.*'],
      ['infra/main.tf', '**/*.tf'],
    ])('touching %s trips %s', (path, glob) => {
      expect(fired([modified('src/a.ts'), modified(path)])).toEqual({ tripwire: glob, detail: path });
    });

    test('a deleted file, or a renamed one’s old path, trips a path too', () => {
      expect(fired([deleted('.github/CODEOWNERS')])).toEqual({ tripwire: '.github/**', detail: '.github/CODEOWNERS' });
      expect(fired([{ path: 'src/old.sql', from: 'db/migrations/1.sql', status: 'renamed', added: [], removed: [] }])).toEqual({
        tripwire: '**/migrations/**',
        detail: 'db/migrations/1.sql',
      });
    });

    test('only the configured paths trip', () => {
      const tripwires = { paths: ['infra/**'], predicates: [] };
      expect(fired([modified('.github/workflows/ci.yml')], [], tripwires)).toBeNull();
      expect(fired([modified('infra/vpc.yaml')], [], tripwires)).toEqual({ tripwire: 'infra/**', detail: 'infra/vpc.yaml' });
    });
  });

  describe('dependency-change', () => {
    test.each(['package.json', 'packages/web/package.json', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle.kts'])(
      'a change to the manifest %s trips it',
      (path) => {
        expect(fired([modified(path, ['x'])])).toEqual({ tripwire: 'dependency-change', detail: path });
      },
    );

    test('a lockfile changed alone trips nothing', () => {
      expect(fired([modified('package-lock.json', ['x']), modified('Cargo.lock'), modified('go.sum'), modified('poetry.lock'), modified('yarn.lock')])).toBeNull();
    });

    test('not configured, it trips nothing', () => {
      expect(fired([modified('package.json', ['x'])], [], { paths: [], predicates: ['tests-removed-or-skipped', 'high-severity-finding'] })).toBeNull();
    });
  });

  describe('tests-removed-or-skipped', () => {
    test.each(['src/login.test.ts', 'web/login.spec.tsx', 'tests/test_login.py', 'pkg/login_test.go', 'src/__tests__/login.js'])('deleting the test file %s trips it', (path) => {
      expect(fired([deleted(path, ["test('logs in', () => {"])])).toEqual({ tripwire: 'tests-removed-or-skipped', detail: `${path} is deleted` });
    });

    test('renaming a test file to one that is no test trips it', () => {
      expect(fired([{ path: 'src/login.ts', from: 'src/login.test.ts', status: 'renamed', added: [], removed: [] }])).toEqual({
        tripwire: 'tests-removed-or-skipped',
        detail: 'src/login.test.ts is deleted',
      });
    });

    test.each([
      "  test.skip('logs in', () => {",
      "  it.skip('logs in', () => {",
      "describe.skip('login', () => {",
      "  xit('logs in', () => {",
      "  it.only('logs in', () => {",
      '@pytest.mark.skip(reason="flaky")',
      '    @unittest.skip("later")',
      '\tt.Skip("flaky")',
    ])('a test file gaining %j trips it', (line) => {
      expect(fired([modified('src/login.test.ts', [line], [])])?.tripwire).toBe('tests-removed-or-skipped');
      expect(fired([modified('src/login.test.ts', [line], [])])?.detail).toBe('src/login.test.ts skips tests');
    });

    test('a test file losing more tests than it gains trips it', () => {
      const removed = ["test('logs in', () => {", "test('logs out', () => {"];
      expect(fired([modified('src/login.test.ts', ["test('logs in, renamed', () => {"], removed)])).toEqual({
        tripwire: 'tests-removed-or-skipped',
        detail: 'src/login.test.ts loses tests',
      });
    });

    test('a test file whose tests are edited, renamed or added trips nothing', () => {
      expect(fired([modified('src/login.test.ts', ["test('logs in, renamed', () => {", "it('logs out', () => {"], ["test('logs in', () => {"])])).toBeNull();
      expect(fired([added('src/logout.test.ts', ["test('logs out', () => {"])])).toBeNull();
    });

    test('a skip outside a test file trips nothing', () => {
      expect(fired([modified('src/runner.ts', ['  it.skip = noop;'])])).toBeNull();
    });
  });

  describe('high-severity-finding', () => {
    test('a high-severity finding left over trips it', () => {
      expect(fired([], ['login() stores the password in plain text.'])).toEqual({ tripwire: 'high-severity-finding', detail: 'login() stores the password in plain text.' });
    });

    test('not configured, it trips nothing', () => {
      expect(fired([], ['login() stores the password in plain text.'], { paths: DEFAULTS.paths, predicates: ['dependency-change'] })).toBeNull();
    });
  });

  test('the first tripwire to fire is the one named: paths, then the predicates in order', () => {
    expect(fired([modified('package.json'), modified('.github/x.yml')], ['bad'])).toEqual({ tripwire: '.github/**', detail: '.github/x.yml' });
    expect(fired([modified('package.json')], ['bad'])).toEqual({ tripwire: 'dependency-change', detail: 'package.json' });
  });

  test('the reason names the tripwire and what tripped it', () => {
    expect(tripwireReason({ tripwire: '.github/**', detail: '.github/workflows/ci.yml' })).toBe('The tripwire .github/** fired: the factory’s commits touch .github/workflows/ci.yml.');
    expect(tripwireReason({ tripwire: 'dependency-change', detail: 'package.json' })).toBe(
      'The tripwire dependency-change fired: the factory’s commits change the dependency manifest package.json.',
    );
    expect(tripwireReason({ tripwire: 'tests-removed-or-skipped', detail: 'src/a.test.ts is deleted' })).toBe(
      'The tripwire tests-removed-or-skipped fired: in the factory’s commits, src/a.test.ts is deleted.',
    );
    expect(tripwireReason({ tripwire: 'high-severity-finding', detail: 'X is wrong.' })).toBe(
      'The tripwire high-severity-finding fired: the review left a high-severity finding over: X is wrong.',
    );
  });
});
