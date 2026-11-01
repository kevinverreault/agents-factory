// Task worktrees (ADR 0010): each root task gets one task branch, cut from a
// freshly fetched `origin/<base_branch>`, and one worktree for it under the
// global worktree root.
import { join } from 'node:path';
import { GitError, type Git } from '../git/git.ts';
import type { Repository, TaskWorktree } from '../lifecycle/lifecycle.ts';

const TITLE_LENGTH = 72;
const SLUG_LENGTH = 40;

// A task's title: the first line of its prompt, cut to fit a row.
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0]!.trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
}

// Where task `taskId` of `repository` works: `factory/<id>-<slug>`, in
// `<root>/<owner>-<name>/<id>`.
export function taskWorktree(root: string, repository: Repository, taskId: string, title: string): TaskWorktree {
  const slug = slugOf(title);
  return {
    branch: `factory/${taskId}${slug ? `-${slug}` : ''}`,
    path: worktreePath(root, repository, taskId),
  };
}

// Where child `childId`, its parent's `n`th, works (ADR 0009): its branch
// `<parent branch>--c<n>`, in its own worktree beside the task worktrees.
export function childWorktree(root: string, repository: Repository, parent: TaskWorktree, childId: string, n: number): TaskWorktree {
  return { branch: `${parent.branch}--c${n}`, path: worktreePath(root, repository, childId) };
}

function worktreePath(root: string, repository: Repository, taskId: string): string {
  return join(root, repository.id.replace('/', '-'), taskId);
}

// Brings `origin/<base_branch>` up to date, or says why it couldn't.
export async function fetchBase(git: Git, { id, path, baseBranch }: Repository): Promise<string | null> {
  try {
    await git.fetch(path, baseBranch);
    return null;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return `Couldn't fetch ${baseBranch} from the origin of ${id}: ${error.message}`;
  }
}

// Cuts the task branch from the fetched base branch into its worktree, or
// says why it couldn't.
export async function cutWorktree(git: Git, repository: Repository, worktree: TaskWorktree): Promise<string | null> {
  const { path: clone, baseBranch } = repository;
  try {
    await git.addWorktree(clone, { ...worktree, startPoint: `origin/${baseBranch}` });
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return `Couldn't create the worktree for ${worktree.branch}: ${error.message}`;
  }
  return null;
}

function slugOf(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_LENGTH) return slug || word.slice(0, SLUG_LENGTH);
    slug = next;
  }
  return slug;
}
