// A semi-auto gate check's tripwires (ADR 0014): evaluated without a model,
// before any judging run, over what the factory's own AFK commits changed
// since the base and the review findings left over after fix-once. One that
// fires sends the PR to the operator, naming it and what tripped it.
import { posix } from 'node:path';
import type { ChangedFile } from '../git/git.ts';
import type { MergeGateConfig, TripwirePredicate } from './merge-gate.ts';

// What the tripwires look at: the files the factory's commits changed, one
// entry per commit that changed one, and the findings the review left over
// that it rated high-severity.
export type TripwireInput = { files: ChangedFile[]; highFindings: string[] };

// The tripwire that fired: a path glob, with the path that matched it, or
// a predicate, with what tripped it: the manifest, what happened to the
// test file, or the finding.
export type FiredTripwire = { kind: 'path'; glob: string; path: string } | { kind: 'predicate'; predicate: TripwirePredicate; detail: string };

// The first of `tripwires` to fire on `input`, or null: the paths in their
// order, then the predicates in theirs.
export function evaluateTripwires(tripwires: MergeGateConfig['tripwires'], input: TripwireInput): FiredTripwire | null {
  for (const glob of tripwires.paths) {
    const path = input.files.flatMap(pathsOf).find((path) => matchesGlob(path, glob));
    if (path) return { kind: 'path', glob, path };
  }
  for (const predicate of tripwires.predicates) {
    const detail = PREDICATES[predicate].fires(input);
    if (detail) return { kind: 'predicate', predicate, detail };
  }
  return null;
}

// Whether `tripwires` read the files the factory's commits changed: all
// but a high-severity finding do.
export function readsChanges(tripwires: MergeGateConfig['tripwires']): boolean {
  return tripwires.paths.length > 0 || tripwires.predicates.some((predicate) => PREDICATES[predicate].readsChanges);
}

// Why the PR went to the operator, for its Needs you item.
export function tripwireReason(fired: FiredTripwire): string {
  const [name, what] = fired.kind === 'path' ? [fired.glob, `the factory’s commits touch ${fired.path}`] : [fired.predicate, PREDICATES[fired.predicate].says(fired.detail)];
  return `The tripwire ${name} fired: ${what}${/[.!?]$/.test(what) ? '' : '.'}`;
}

// Whether `path` (from the top, with `/`) matches `glob`, files and
// directories whose names start with a dot included, as the operator means
// them: `**` any run of whole segments, none included, `*` and `?` any
// characters and one within a segment, `[…]` (`[!…]` negated) one of a
// class, and `{a,b}` either of its alternatives.
export function matchesGlob(path: string, glob: string): boolean {
  return new RegExp(`^${globSource(glob)}$`).test(path);
}

// The regular expression `glob` stands for.
function globSource(glob: string): string {
  let source = '';
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at]!;
    const segmentStart = at === 0 || glob[at - 1] === '/';
    if (glob.startsWith('**', at) && segmentStart && glob[at + 2] === '/') {
      source += '(?:[^/]*/)*';
      at += 2;
    } else if (glob.startsWith('**', at) && segmentStart && at + 2 === glob.length) {
      source += '.*';
      at += 1;
    } else if (char === '*') {
      source += '[^/]*';
      while (glob[at + 1] === '*') at++;
    } else if (char === '?') source += '[^/]';
    else if (char === '[' && glob.indexOf(']', at + 2) !== -1) {
      const end = glob.indexOf(']', at + 2);
      const members = glob.slice(at + 1, end);
      source += `[${members.startsWith('!') ? `^${members.slice(1)}` : members}]`.replace(/\\/g, '\\\\');
      at = end;
    } else if (char === '{' && glob.indexOf('}', at) !== -1) {
      const end = glob.indexOf('}', at);
      source += `(?:${glob.slice(at + 1, end).split(',').map(globSource).join('|')})`;
      at = end;
    } else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

// The paths a changed file was at: a renamed one's old path too.
function pathsOf(file: ChangedFile): string[] {
  return file.from ? [file.from, file.path] : [file.path];
}

// Each predicate: what it fired on, if it did, whether that needs the
// changed files, and how its reason says what tripped it.
type Predicate = { fires: (input: TripwireInput) => string | null; readsChanges: boolean; says: (detail: string) => string };
const PREDICATES: Record<TripwirePredicate, Predicate> = {
  'dependency-change': {
    fires: ({ files }) => files.flatMap(pathsOf).find(isManifest) ?? null,
    readsChanges: true,
    says: (manifest) => `the factory’s commits change the dependency manifest ${manifest}`,
  },
  'tests-removed-or-skipped': {
    fires: ({ files }) => files.map(testsRemovedOrSkipped).find(Boolean) ?? null,
    readsChanges: true,
    says: (what) => `in the factory’s commits, ${what}`,
  },
  'high-severity-finding': {
    fires: ({ highFindings }) => highFindings[0] ?? null,
    readsChanges: false,
    says: (finding) => `the review left a high-severity finding over: ${finding}`,
  },
};

// The files that declare a project's dependencies. Their lockfiles aren't
// among them: a lockfile changed alone adds or upgrades nothing declared.
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  '*.gemspec',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  '*.csproj',
  'packages.config',
];

// Whether the file at `path` declares dependencies.
function isManifest(path: string): boolean {
  const name = posix.basename(path);
  return /^requirements.*\.(txt|in)$/.test(name) || MANIFESTS.some((manifest) => matchesGlob(name, manifest));
}

// Test files, by the conventions of the common test runners. Rust's inline
// tests live in any source file: a `.rs` file counts once a line its
// commit changed is a test's attribute.
function isTestFile(path: string, lines: string[] = []): boolean {
  const name = posix.basename(path);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.(py|go|rb|exs?|rs)$/.test(name) ||
    /_spec\.rb$/.test(name) ||
    /(Test|Tests)\.(java|kt|cs)$/.test(name) ||
    /(^|\/)__tests__\//.test(path) ||
    /(^|\/)tests\/.*\.rs$/.test(path) ||
    (name.endsWith('.rs') && lines.some((line) => RUST_TEST.test(line)))
  );
}

// A test framework's name for a test or a group of them, standing alone:
// not a method of something else, such as a regular expression's `.test`.
const ALONE = '(?<![\\w.$])';
// A line that skips tests, or with `.only` or a focused `fit`, all the others.
const SKIP = new RegExp(
  [
    `${ALONE}(?:describe|context|suite|it|test|bench)\\.(?:skip|skipIf|runIf|only)\\b`,
    `${ALONE}(?:x(?:it|describe|test|context)|f(?:it|describe))\\s*\\(`,
    '@pytest\\.mark\\.skip',
    '\\bpytest\\.skip\\s*\\(',
    '\\.skipTest\\s*\\(',
    '\\bthis\\.skip\\s*\\(',
    '@unittest\\.skip',
    '@(?:Disabled|Ignore)\\b',
    '\\bt\\.Skip(?:Now|f)?\\(',
    '#\\[ignore\\b',
  ].join('|'),
);
// A line that declares a test.
const DECLARES = new RegExp(
  [`${ALONE}(?:it|test|specify)(?:\\.\\w+)?\\s*\\(`, '^\\s*(?:async\\s+)?def\\s+test_', '^\\s*func\\s+Test\\w*\\s*\\(', '@Test\\b', '#\\[(?:\\w+::)?test\\b'].join('|'),
);
// A Rust attribute that marks a test, or a test module or an ignored test.
const RUST_TEST = /#\[(?:(?:\w+::)?test\b|cfg\(test\)|ignore\b)/;

// What the commit did to the tests in the file, if it deleted or skipped any.
function testsRemovedOrSkipped(file: ChangedFile): string | null {
  const was = file.from ?? file.path;
  if (isTestFile(was) && (file.status === 'deleted' || (file.status === 'renamed' && !isTestFile(file.path)))) return `${was} is deleted`;
  if (!isTestFile(file.path, [...file.added, ...file.removed])) return null;
  if (file.added.some((line) => SKIP.test(line))) return `${file.path} skips tests`;
  const count = (lines: string[]) => lines.filter((line) => DECLARES.test(line)).length;
  return count(file.removed) > count(file.added) ? `${file.path} loses tests` : null;
}
