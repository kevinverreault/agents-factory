// `agents-factory merge-gate [repo]` (ADR 0014): prints the merge gate
// config resolved for a repository, as a task launched or handed off now
// would freeze it. With no repository named, it is the one whose clone the
// working directory is in, or none outside a clone. It reads the operator's
// file alone: the clone is asked only which repository it is.
import { existsSync } from 'node:fs';
import type { Git } from '../git/git.ts';
import { isOwnerName, readClone } from '../repositories/registry.ts';
import { mergeGateYaml, readMergeGateConfig } from './merge-gate.ts';

export type MergeGateCommand = {
  // The operator's merge-gate.yaml.
  path: string;
  repo: string | undefined;
  cwd: string;
  git: Git;
  print(text: string): void;
  printError(text: string): void;
};

export async function mergeGateCommand({ path, repo, cwd, git, print, printError }: MergeGateCommand): Promise<number> {
  if (repo !== undefined && !isOwnerName(repo)) {
    printError(`${repo} is not a repository: name it owner/name.`);
    return 2;
  }
  let forRepo = repo ?? null;
  if (forRepo === null) {
    const clone = await readClone(git, cwd);
    if (!('refusal' in clone)) forRepo = clone.repo;
  }
  const resolved = readMergeGateConfig(path, forRepo);
  if ('error' in resolved) {
    printError(resolved.error);
    return 1;
  }
  const layers = !existsSync(path)
    ? `the built-in defaults (there is no ${path})`
    : `the built-in defaults, overridden by ${path}${resolved.section ? `, then by its section for ${resolved.section}` : forRepo ? `, which has no section for ${forRepo}` : ''}`;
  print(`The merge gate for ${forRepo ?? 'repositories with no section'}: ${layers}.`);
  print(mergeGateYaml(resolved.config));
  return 0;
}
