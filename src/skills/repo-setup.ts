// The skill set's per-repo setup: the docs `/factory:setup-matt-pocock-skills`
// writes so the skills find the issue tracker and triage labels they expect.
// The factory reads them on the repository's base branch on origin, where a
// setup task's work lands once merged.
import { GitError, type Git } from '../git/git.ts';
import type { Repository, SkillsSetup } from '../lifecycle/lifecycle.ts';

export const SETUP_DIR = 'docs/agents';
export const SETUP_DOCS = [`${SETUP_DIR}/issue-tracker.md`, `${SETUP_DIR}/triage-labels.md`];
// The built-in preset "Set up now" launches.
export const SETUP_PRESET = 'setup';

// Whether the repository's base branch, as its clone last fetched it, has
// every setup doc.
export async function checkSkillsSetup(git: Git, repository: Repository, checkedAt: number): Promise<SkillsSetup> {
  const { id, path, baseBranch } = repository;
  const ref = `origin/${baseBranch}`;
  let found: Set<string>;
  try {
    const { files } = await git.readDirectory(path, ref, SETUP_DIR);
    found = new Set(files.map((file) => file.path));
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return { present: false, checkedAt, reason: `The factory couldn’t check the skill set’s setup in ${id} at ${ref}: ${error.message}` };
  }
  const missing = SETUP_DOCS.filter((doc) => !found.has(doc));
  if (missing.length === 0) return { present: true, checkedAt };
  return {
    present: false,
    checkedAt,
    reason: `${id} has no setup for the skill set on ${baseBranch} (${missing.join(', ')}): its skills won’t find the issue tracker and labels they expect.`,
  };
}
