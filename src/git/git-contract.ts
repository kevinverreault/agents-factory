// The Git port's contract, shared by the fake and the real adapter so the two
// can't drift apart.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Git } from './git.ts';

export type CloneFixture = {
  git: Git;
  // A directory outside every clone.
  root: string;
  // Makes a clone at `<root>/<name>` with a `src` directory inside it, and
  // returns its path.
  clone(name: string, setup: { originUrl?: string; defaultBranch?: string }): Promise<string>;
  move(from: string, to: string): Promise<void>;
  dispose(): Promise<void>;
};

export function describeGitContract(name: string, makeFixture: () => Promise<CloneFixture>): void {
  describe(`${name}: reading a clone`, () => {
    async function withFixture(body: (fixture: CloneFixture) => Promise<void>): Promise<void> {
      const fixture = await makeFixture();
      try {
        await body(fixture);
      } finally {
        await fixture.dispose();
      }
    }

    test('a clone is read the same from its top level and from a directory inside it', () =>
      withFixture(async ({ git, clone }) => {
        const path = await clone('widgets', { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'trunk' });
        const expected = { path, originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'trunk' };

        expect(await git.inspectClone(path)).toEqual(expected);
        expect(await git.inspectClone(join(path, 'src'))).toEqual(expected);
      }));

    test('a clone without an origin, or whose origin/HEAD is unset, says so with null', () =>
      withFixture(async ({ git, clone }) => {
        const local = await clone('local', {});
        const unset = await clone('unset', { originUrl: 'git@github.com:acme/unset.git' });

        expect(await git.inspectClone(local)).toEqual({ path: local, originUrl: null, defaultBranch: null });
        expect(await git.inspectClone(unset)).toEqual({ path: unset, originUrl: 'git@github.com:acme/unset.git', defaultBranch: null });
      }));

    test('a directory outside every clone, or a path that does not exist, is no clone', () =>
      withFixture(async ({ git, root }) => {
        expect(await git.inspectClone(root)).toBeNull();
        expect(await git.inspectClone(join(root, 'nowhere'))).toBeNull();
      }));

    test('a moved clone is found at its new path only', () =>
      withFixture(async ({ git, root, clone, move }) => {
        const before = await clone('widgets', { originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
        const after = join(root, 'moved');

        await move(before, after);

        expect(await git.inspectClone(before)).toBeNull();
        expect(await git.inspectClone(after)).toEqual({ path: after, originUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main' });
      }));
  });
}
