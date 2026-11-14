// `agents-factory merge-gate [repo]` (ADR 0014): prints the merge gate
// config resolved for a repository, as a task launched or handed off now
// would freeze it. With no repository named, it is the one whose clone the
// working directory is in, or none outside a clone. It reads the operator's
// file alone: the clone is asked only which repository it is.
import { existsSync } from 'node:fs';
import type { Git } from '../git/git.ts';
import { readClone } from '../repositories/registry.ts';
import { mergeGateYaml, readMergeGate, REPOSITORY } from './merge-gate.ts';

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
  if (repo !== undefined && !REPOSITORY.test(repo)) {
    printError(`${repo} is not a repository: name it owner/name.`);
    return 2;
  }
  let target = repo ?? null;
  if (target === null) {
    const clone = await readClone(git, cwd);
    if (!('refusal' in clone)) target = clone.repo;
  }
  const resolved = readMergeGate(path, target);
  if ('error' in resolved) {
    printError(resolved.error);
    return 1;
  }
  const subject = target ?? 'repositories with no section';
  const layers = existsSync(path)
    ? `the built-in defaults, overridden by ${path}${target ? `, then by any section it has for ${target}` : ''}`
    : `the built-in defaults (there is no ${path})`;
  print(`The merge gate for ${subject}: ${layers}.`);
  print(mergeGateYaml(resolved.config));
  return 0;
}
