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
  // Makes a clone at `<root>/<name>` whose origin is reachable and has
  // `branch`, and returns its path.
  cloneWithOrigin(name: string, branch: string): Promise<string>;
  // Adds a commit to `branch` on the clone's origin, not yet fetched, and
  // returns its hash.
  advanceOrigin(clonePath: string, branch: string): Promise<string>;
  // Writes `path` (relative, with `/`) in the worktree, without committing it.
  editFile(worktreePath: string, path: string): Promise<void>;
  // Commits everything changed in the worktree.
  commitAll(worktreePath: string): Promise<void>;
  dispose(): Promise<void>;
};

export function describeGitContract(name: string, makeFixture: () => Promise<CloneFixture>): void {
  async function withFixture(body: (fixture: CloneFixture) => Promise<void>): Promise<void> {
    const fixture = await makeFixture();
    try {
      await body(fixture);
    } finally {
      await fixture.dispose();
    }
  }

  describe(`${name}: reading a clone`, () => {
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

  describe(`${name}: task worktrees`, () => {
    test('a task branch is cut from origin’s freshly fetched tip into a new worktree', () =>
      withFixture(async ({ git, root, cloneWithOrigin, advanceOrigin }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const tip = await advanceOrigin(clone, 'main');
        const path = join(root, 'worktrees', 'acme-widgets', 'T1');
        expect(await git.worktrees(clone)).toEqual([]);

        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-grill-me', startPoint: 'origin/main' });

        expect(await git.worktrees(clone)).toEqual([{ path, branch: 'factory/T1-grill-me', head: tip }]);
      }));

    test('fetching a branch origin doesn’t have fails, and so does cutting a branch that already exists', () =>
      withFixture(async ({ git, root, cloneWithOrigin }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path: join(root, 'wt', 'T1'), branch: 'factory/T1-a', startPoint: 'origin/main' });

        await expect(git.fetch(clone, 'nowhere')).rejects.toThrow();
        await expect(
          git.addWorktree(clone, { path: join(root, 'wt', 'T2'), branch: 'factory/T1-a', startPoint: 'origin/main' }),
        ).rejects.toThrow();
        expect((await git.worktrees(clone)).map((worktree) => worktree.branch)).toEqual(['factory/T1-a']);
      }));

    test('a worktree tells which files have uncommitted changes, new files included, until they are committed', () =>
      withFixture(async ({ git, root, cloneWithOrigin, editFile, commitAll }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'wt', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
        const files = ['GLOSSARY.md', 'docs/adr/0001 sso cookies.md', 'README.md'];
        expect(await git.uncommitted(path, files)).toEqual([]);

        await editFile(path, 'GLOSSARY.md');
        await editFile(path, 'docs/adr/0001 sso cookies.md');
        expect(await git.uncommitted(path, files)).toEqual(['GLOSSARY.md', 'docs/adr/0001 sso cookies.md']);

        await commitAll(path);
        expect(await git.uncommitted(path, files)).toEqual([]);

        await editFile(path, 'GLOSSARY.md');
        expect(await git.uncommitted(path, files)).toEqual(['GLOSSARY.md']);
      }));

    test('a task worktree stops working when its clone moves, and works again once repaired from the new path', () =>
      withFixture(async ({ git, root, cloneWithOrigin, move }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'worktrees', 'acme-widgets', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-grill-me', startPoint: 'origin/main' });
        const [worktree] = await git.worktrees(clone);
        // A worktree reads as the clone it belongs to.
        const before = await git.inspectClone(clone);
        expect(await git.inspectClone(path)).toEqual(before);
        const moved = join(root, 'moved');

        await move(clone, moved);
        expect(await git.inspectClone(path)).toBeNull();
        await git.repairWorktree(moved, path);

        expect(await git.inspectClone(path)).toEqual({ ...before, path: moved });
        expect(await git.worktrees(moved)).toEqual([worktree]);
      }));

    test('repairing a path that is no worktree of the clone fails', () =>
      withFixture(async ({ git, root, cloneWithOrigin }) => {
        const clone = await cloneWithOrigin('widgets', 'main');

        await expect(git.repairWorktree(clone, join(root, 'worktrees', 'nowhere'))).rejects.toThrow();
      }));
  });
}
