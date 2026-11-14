// A semi-auto gate check's tripwires (ADR 0014): evaluated without a model,
// before any judging run, over what the factory's own AFK commits changed
// since the base and the review findings left over after fix-once. One that
// fires sends the PR to the operator, naming it and what tripped it.
import { matchesGlob } from 'node:path';
import type { MergeGateConfig, TripwirePredicate } from './merge-gate.ts';

// A file a commit changed, by its path from the top (with `/`), and the
// path it was renamed from, if it was: the lines the commit added to it
// and removed from it.
export type ChangedFile = {
  path: string;
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: string[];
  removed: string[];
};

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
    const path = input.files.flatMap(pathsOf).find((path) => matchesGlob(path, glob));
    if (path) return { tripwire: glob, detail: path };
  }
  for (const predicate of tripwires.predicates) {
    const detail = PREDICATES[predicate](input);
    if (detail) return { tripwire: predicate, detail };
  }
  return null;
}

// Why the PR went to the operator, for its Needs you item.
export function tripwireReason({ tripwire, detail }: FiredTripwire): string {
  const what =
    tripwire === 'dependency-change'
      ? `the factory’s commits change the dependency manifest ${detail}`
      : tripwire === 'tests-removed-or-skipped'
        ? `in the factory’s commits, ${detail}`
        : tripwire === 'high-severity-finding'
          ? `the review left a high-severity finding over: ${detail}`
          : `the factory’s commits touch ${detail}`;
  return `The tripwire ${tripwire} fired: ${what}${/[.!?]$/.test(what) ? '' : '.'}`;
}

function pathsOf(file: ChangedFile): string[] {
  return file.from ? [file.from, file.path] : [file.path];
}

const PREDICATES: Record<TripwirePredicate, (input: TripwireInput) => string | null> = {
  'dependency-change': ({ files }) => files.flatMap(pathsOf).find(isManifest) ?? null,
  'tests-removed-or-skipped': ({ files }) => files.map(testsRemovedOrSkipped).find(Boolean) ?? null,
  'high-severity-finding': ({ highFindings }) => highFindings[0] ?? null,
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

function isManifest(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /^requirements.*\.(txt|in)$/.test(name) || MANIFESTS.some((manifest) => matchesGlob(name, manifest));
}

// Test files, by the conventions of the common test runners.
function isTestFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
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
