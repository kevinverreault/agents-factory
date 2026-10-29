// The repository registry (ADR 0010): what `repo add` makes of a clone, and
// whether a registered repository's clone is still where it was left.
import { isAbsolute } from 'node:path';
import type { Git } from '../git/git.ts';
import type { Repository } from '../lifecycle/lifecycle.ts';

export const DEFAULT_PRESET = 'main-flow';

export type CloneOfRepo = {
  // `owner/name` on GitHub.
  repo: string;
  path: string;
  defaultBranch: string | null;
};

// The GitHub repository the clone at `path` belongs to, or why it can't be
// registered.
export async function readClone(git: Git, path: string): Promise<CloneOfRepo | { refusal: string }> {
  if (!isAbsolute(path)) return { refusal: `The clone path must be absolute, not ${path}.` };
  const clone = await git.inspectClone(path);
  if (!clone) return { refusal: `${path} is not inside a git clone.` };
  const repo = clone.originUrl === null ? null : gitHubRepo(clone.originUrl);
  if (!repo) return { refusal: `The clone at ${clone.path} has no GitHub origin.` };
  return { repo, path: clone.path, defaultBranch: clone.defaultBranch };
}

// Why the repository's clone is no longer where it was registered, or null
// when its path still holds a clone of the same `owner/name` (ADR 0010).
export async function whyMissing(git: Git, repository: Repository): Promise<string | null> {
  const clone = await readClone(git, repository.path);
  const inPlace = !('refusal' in clone) && clone.repo === repository.id && samePath(clone.path, repository.path);
  return inPlace ? null : `The clone of ${repository.id} is no longer at ${repository.path}.`;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// `owner/name` from an https, ssh or scp-style GitHub URL, or null.
export function gitHubRepo(url: string): string | null {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
