// `agents-factory merge-gate [repo]`: prints the resolved merge gate config
// for a repository, the one in the working directory's clone when none is
// named, or the operator's file alone outside one.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { FakeGit } from '../testing/fake-git.ts';
import { mergeGateCommand } from './merge-gate-command.ts';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setUp(content?: string) {
  const home = mkdtempSync(join(tmpdir(), 'merge-gate-'));
  homes.push(home);
  const path = join(home, 'merge-gate.yaml');
  if (content !== undefined) writeFileSync(path, content);
  const out: string[] = [];
  const err: string[] = [];
  const git = new FakeGit();
  const run = (repo: string | undefined, cwd = resolve('/elsewhere')) =>
    mergeGateCommand({ path, repo, cwd, git, print: (line) => out.push(line), printError: (line) => err.push(line) });
  return { path, git, out, err, run };
}

const SECTION = 'merge_method: rebase\nrepositories:\n  acme/widgets:\n    merge_method: squash\n';

test('it prints the config resolved for the repository named', async () => {
  const { out, run, path } = setUp(SECTION);
  expect(await run('acme/widgets')).toBe(0);
  expect(out[0]).toBe(`The merge gate for acme/widgets: the built-in defaults, overridden by ${path}, then by any section it has for acme/widgets.`);
  expect(out[1]).toContain('merge_method: squash\n');
  expect(out[1]).toContain('- "**/migrations/**"');
  expect(out[1]).toContain('- high-severity-finding');
});

test('with no repository named, it is the working directory’s clone’s', async () => {
  const { out, run, git } = setUp(SECTION);
  git.addClone(resolve('/clones/widgets'), { originUrl: 'https://github.com/acme/widgets.git' });
  expect(await run(undefined, resolve('/clones/widgets/src'))).toBe(0);
  expect(out[0]).toMatch(/^The merge gate for acme\/widgets: /);
  expect(out[1]).toContain('merge_method: squash\n');
});

test('outside a clone, with no repository named, it is the operator’s file alone', async () => {
  const { out, run, path } = setUp(SECTION);
  expect(await run(undefined)).toBe(0);
  expect(out[0]).toBe(`The merge gate for repositories with no section: the built-in defaults, overridden by ${path}.`);
  expect(out[1]).toContain('merge_method: rebase\n');
});

test('with no file, it is the built-in defaults', async () => {
  const { out, run, path } = setUp();
  expect(await run('acme/widgets')).toBe(0);
  expect(out[0]).toBe(`The merge gate for acme/widgets: the built-in defaults (there is no ${path}).`);
  expect(out[1]).toContain('merge_method: merge\n');
});

test('an invalid file is refused with the reason', async () => {
  const { out, err, run, path } = setUp('merge_method: ff\n');
  expect(await run('acme/widgets')).toBe(1);
  expect(out).toEqual([]);
  expect(err).toEqual([`The merge gate config at ${path} is invalid: merge_method must be merge, squash or rebase, not ff.`]);
});

test('a repository that isn’t owner/name is refused', async () => {
  const { err, run } = setUp();
  expect(await run('widgets')).toBe(2);
  expect(err).toEqual(['widgets is not a repository: name it owner/name.']);
});
