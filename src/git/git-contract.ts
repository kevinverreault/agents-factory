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
  // returns its hash. The commit writes `files` (by path, with `/`).
  advanceOrigin(clonePath: string, branch: string, files?: Record<string, string>): Promise<string>;
  // Writes `path` (relative, with `/`) in the worktree, without committing it.
  editFile(worktreePath: string, path: string): Promise<void>;
  // Commits everything changed in the worktree.
  commitAll(worktreePath: string): Promise<void>;
  // Cuts `branch` and checks it out in the worktree instead of its own.
  checkout(worktreePath: string, branch: string): Promise<void>;
  // Sets the remote's `pushurl`, as seen from the worktree.
  setPushUrl(worktreePath: string, remote: string, url: string): Promise<void>;
  // Pushes the clone's `branch` to origin under the same name.
  push(clonePath: string, branch: string): Promise<void>;
  // Fast-forwards origin's `base` to the clone's `branch`, as merging its PR would.
  merge(clonePath: string, branch: string, base: string): Promise<void>;
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

    test('a worktree’s state tells the branch checked out, every uncommitted path and each remote’s pushurl', () =>
      withFixture(async ({ git, root, cloneWithOrigin, editFile, checkout, setPushUrl }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'wt', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
        expect(await git.worktreeState(path)).toEqual({ branch: 'factory/T1-a', uncommitted: [], pushUrls: [] });

        await editFile(path, 'GLOSSARY.md');
        await editFile(path, 'src/sso cookies.ts');
        await checkout(path, 'spike');
        await setPushUrl(path, 'origin', 'https://github.com/someone/else.git');

        expect(await git.worktreeState(path)).toEqual({
          branch: 'spike',
          uncommitted: ['GLOSSARY.md', 'src/sso cookies.ts'],
          pushUrls: ['remote.origin.pushurl'],
        });
      }));

    test('a commit takes exactly the paths given, new files included, onto the branch, and leaves other changes uncommitted', () =>
      withFixture(async ({ git, root, cloneWithOrigin, editFile }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'wt', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
        const before = (await git.worktrees(clone))[0]!.head;
        await editFile(path, 'GLOSSARY.md');
        await editFile(path, 'docs/adr/0001 sso cookies.md');
        await editFile(path, 'src/scratch.ts');

        const commit = await git.commit(path, ['GLOSSARY.md', 'docs/adr/0001 sso cookies.md'], 'Handoff of T1');

        expect(commit).not.toBe(before);
        expect(await git.worktrees(clone)).toEqual([{ path, branch: 'factory/T1-a', head: commit }]);
        expect((await git.worktreeState(path)).uncommitted).toEqual(['src/scratch.ts']);
      }));

    test('the commits since a base are those made on the branch after it, oldest first', () =>
      withFixture(async ({ git, root, cloneWithOrigin, editFile, commitAll }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'wt', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
        const base = (await git.worktrees(clone))[0]!.head;
        expect(await git.commitsSince(path, base)).toEqual([]);

        await editFile(path, 'src/logout.ts');
        const first = await git.commit(path, ['src/logout.ts'], 'Add the logout button');
        await editFile(path, 'src/session.ts');
        await commitAll(path);

        const [head] = await git.worktrees(clone);
        expect(await git.commitsSince(path, base)).toEqual([first, head!.head]);
        expect(await git.commitsSince(path, first)).toEqual([head!.head]);
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

    test('a directory is read as the fetched origin tip has it, with that commit, and an unknown ref fails', () =>
      withFixture(async ({ git, cloneWithOrigin, advanceOrigin }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        // Read as committed: CRLF stays CRLF.
        const preset = 'stages:\r\n  - id: a\n';
        const tip = await advanceOrigin(clone, 'main', {
          '.agent-factory/presets/nightly.preset.yaml': preset,
          '.agent-factory/presets/deep/other.preset.yaml': 'stages: []\n',
          'README.md': 'Widgets.\n',
        });
        // Not fetched yet: origin's old tip has no such directory.
        expect((await git.readDirectory(clone, 'origin/main', '.agent-factory/presets')).files).toEqual([]);

        await git.fetch(clone, 'main');

        expect(await git.readDirectory(clone, 'origin/main', '.agent-factory/presets')).toEqual({
          commit: tip,
          files: [{ path: '.agent-factory/presets/nightly.preset.yaml', content: preset }],
        });
        await expect(git.readDirectory(clone, 'origin/nowhere', '.agent-factory/presets')).rejects.toThrow();
      }));

    test('named files are read at a ref as committed there, and those it lacks are left out', () =>
      withFixture(async ({ git, cloneWithOrigin, advanceOrigin }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const tip = await advanceOrigin(clone, 'main', { 'AGENTS.md': '## Agent skills\n', 'docs/agents/issue-tracker.md': '# GitHub\n' });
        await git.fetch(clone, 'main');

        expect(await git.readFiles(clone, 'origin/main', ['AGENTS.md', 'CLAUDE.md', 'docs/agents/issue-tracker.md'])).toEqual({
          commit: tip,
          files: [
            { path: 'AGENTS.md', content: '## Agent skills\n' },
            { path: 'docs/agents/issue-tracker.md', content: '# GitHub\n' },
          ],
        });
        await expect(git.readFiles(clone, 'origin/nowhere', ['AGENTS.md'])).rejects.toThrow();
      }));

    test('a task branch is merged once origin’s base branch, as fetched, has its tip in its history', () =>
      withFixture(async ({ git, root, cloneWithOrigin, editFile, commitAll, merge }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'wt', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
        // Cut from origin's tip, with nothing of its own yet.
        expect(await git.isMerged(clone, 'factory/T1-a', 'origin/main')).toBe(true);

        await editFile(path, 'src/logout.ts');
        await commitAll(path);
        expect(await git.isMerged(clone, 'factory/T1-a', 'origin/main')).toBe(false);

        await merge(clone, 'factory/T1-a', 'main');
        await git.fetch(clone, 'main');
        expect(await git.isMerged(clone, 'factory/T1-a', 'origin/main')).toBe(true);
        await expect(git.isMerged(clone, 'factory/T9-gone', 'origin/main')).rejects.toThrow();
      }));

    test('a task branch’s local commits are those no ref of origin has, as last fetched: none once pushed or merged, or once the branch is gone', () =>
      withFixture(async ({ git, root, cloneWithOrigin, editFile, commitAll, push, merge }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'wt', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
        // Cut from origin's tip, with nothing of its own yet.
        expect(await git.localCommits(clone, 'factory/T1-a')).toEqual([]);

        await editFile(path, 'src/logout.ts');
        await commitAll(path);
        await editFile(path, 'src/header.ts');
        await commitAll(path);
        const { head } = (await git.worktrees(clone))[0]!;
        const local = await git.localCommits(clone, 'factory/T1-a');
        expect(local).toHaveLength(2);
        expect(local).toContain(head);

        await push(clone, 'factory/T1-a');
        expect(await git.localCommits(clone, 'factory/T1-a')).toEqual([]);

        await editFile(path, 'src/footer.ts');
        await commitAll(path);
        expect(await git.localCommits(clone, 'factory/T1-a')).toHaveLength(1);
        await merge(clone, 'factory/T1-a', 'main');
        await git.fetch(clone, 'main');
        expect(await git.localCommits(clone, 'factory/T1-a')).toEqual([]);

        await git.removeWorktree(clone, path);
        await git.deleteBranch(clone, 'factory/T1-a');
        expect(await git.localCommits(clone, 'factory/T1-a')).toEqual([]);
      }));

    test('a task worktree is removed with its uncommitted changes, then its branch, and the branch checks out again from origin', () =>
      withFixture(async ({ git, root, cloneWithOrigin, editFile, commitAll, push }) => {
        const clone = await cloneWithOrigin('widgets', 'main');
        const path = join(root, 'wt', 'T1');
        await git.fetch(clone, 'main');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/main' });
        await editFile(path, 'src/logout.ts');
        await commitAll(path);
        const { head } = (await git.worktrees(clone))[0]!;
        await push(clone, 'factory/T1-a');
        await editFile(path, 'notes.txt');

        await git.removeWorktree(clone, path);
        await git.deleteBranch(clone, 'factory/T1-a');

        expect(await git.worktrees(clone)).toEqual([]);
        await expect(git.isMerged(clone, 'factory/T1-a', 'origin/main')).rejects.toThrow();
        // Both are gone already: doing it again is no error.
        await git.removeWorktree(clone, path);
        await git.deleteBranch(clone, 'factory/T1-a');
        await git.fetch(clone, 'factory/T1-a');
        await git.addWorktree(clone, { path, branch: 'factory/T1-a', startPoint: 'origin/factory/T1-a' });
        expect(await git.worktrees(clone)).toEqual([{ path, branch: 'factory/T1-a', head }]);
      }));

    test('repairing a path that is no worktree of the clone fails', () =>
      withFixture(async ({ git, root, cloneWithOrigin }) => {
        const clone = await cloneWithOrigin('widgets', 'main');

        await expect(git.repairWorktree(clone, join(root, 'worktrees', 'nowhere'))).rejects.toThrow();
      }));
  });
}
