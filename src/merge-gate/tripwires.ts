// A semi-auto gate check's tripwires (ADR 0014): evaluated without a model,
// before any judging run, over what the factory's own AFK commits changed
// since the base and the review findings left over after fix-once. One that
// fires sends the PR to the operator, naming it and what tripped it.
import { posix } from 'node:path';
import type { ChangedFile } from '../git/git.ts';
import type { MergeGateConfig, TripwirePredicate } from './merge-gate.ts';

export type { ChangedFile };

// What the tripwires look at: the files the factory's commits changed, one
// entry per commit that changed one, and the findings the review left over
// that it rated high-severity.
export type TripwireInput = { files: ChangedFile[]; highFindings: string[] };

// The tripwire that fired, a path glob or a predicate, and what tripped it:
// the path, the manifest, what happened to the test file, or the finding.
export type FiredTripwire = { tripwire: string; detail: string };

// The first of `tripwires` to fire on `input`, or null: the paths in their
// order, then the predicates in theirs.
export function evaluateTripwires(tripwires: MergeGateConfig['tripwires'], input: TripwireInput): FiredTripwire | null {
  for (const glob of tripwires.paths) {
    const path = input.files.flatMap(pathsOf).find((path) => posix.matchesGlob(path, glob));
    if (path) return { tripwire: glob, detail: path };
  }
  for (const predicate of tripwires.predicates) {
    const detail = PREDICATES[predicate].fires(input);
    if (detail) return { tripwire: predicate, detail };
  }
  return null;
}

// Whether `tripwires` read the files the factory's commits changed: all
// but a high-severity finding do.
export function readsChanges(tripwires: MergeGateConfig['tripwires']): boolean {
  return tripwires.paths.length > 0 || tripwires.predicates.some((predicate) => PREDICATES[predicate].readsChanges);
}

// Why the PR went to the operator, for its Needs you item.
export function tripwireReason({ tripwire, detail }: FiredTripwire): string {
  const predicate = PREDICATES[tripwire as TripwirePredicate];
  const what = predicate ? predicate.says(detail) : `the factory’s commits touch ${detail}`;
  return `The tripwire ${tripwire} fired: ${what}${/[.!?]$/.test(what) ? '' : '.'}`;
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
  return /^requirements.*\.(txt|in)$/.test(name) || MANIFESTS.some((manifest) => posix.matchesGlob(name, manifest));
}

// Test files, by the conventions of the common test runners.
function isTestFile(path: string): boolean {
  const name = posix.basename(path);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.(py|go|rb|exs?)$/.test(name) ||
    /_spec\.rb$/.test(name) ||
    /(Test|Tests)\.(java|kt|cs)$/.test(name) ||
    /(^|\/)__tests__\//.test(path)
  );
}

// A line that skips tests, or with `.only`, all the others.
const SKIP = /\b(?:(?:describe|context|suite|it|test|bench)\.(?:skip|only|todo)|x(?:it|describe|test|context))\s*\(|@pytest\.mark\.skip|@unittest\.skip|@(?:Disabled|Ignore)\b|\bt\.Skip(?:Now|f)?\(|#\[ignore\]|\bskip\s*\(\s*["']/;
// A line that declares a test.
const DECLARES = /\b(?:it|test|specify)(?:\.\w+)?\s*\(|^\s*(?:async\s+)?def\s+test_|^\s*func\s+Test\w*\s*\(|@Test\b|#\[test\]/;

// What the commit did to the tests in the file, if it deleted or skipped any.
function testsRemovedOrSkipped(file: ChangedFile): string | null {
  const was = file.from ?? file.path;
  if (isTestFile(was) && (file.status === 'deleted' || (file.status === 'renamed' && !isTestFile(file.path)))) return `${was} is deleted`;
  if (!isTestFile(file.path)) return null;
  if (file.added.some((line) => SKIP.test(line))) return `${file.path} skips tests`;
  const count = (lines: string[]) => lines.filter((line) => DECLARES.test(line)).length;
  return count(file.removed) > count(file.added) ? `${file.path} loses tests` : null;
}
