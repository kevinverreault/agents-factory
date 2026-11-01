// The skill set's per-repo setup (ADR 0010): what
// `/factory:setup-matt-pocock-skills` leaves so the skills find the issue
// tracker and labels they expect. It is done when `docs/agents/issue-tracker.md`
// and an `## Agent skills` block in `AGENTS.md` or `CLAUDE.md` are on the
// repository's base branch on origin, where a setup task's work lands once
// merged.
import { GitError, type Git } from '../git/git.ts';
import type { Repository, SkillsSetup } from '../lifecycle/lifecycle.ts';

const ISSUE_TRACKER = 'docs/agents/issue-tracker.md';
const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md'];
const AGENT_SKILLS = /^## Agent skills[ \t]*\r?$/m;
// The built-in preset "Set up now" launches.
export const SETUP_PRESET = 'setup';

// Whether the repository's base branch, as its clone last fetched it, has
// the setup.
export async function checkSkillsSetup(git: Git, repository: Repository, checkedAt: number): Promise<SkillsSetup> {
  const { id, baseBranch } = repository;
  const ref = `origin/${baseBranch}`;
  let files: Map<string, string>;
  try {
    const read = await git.readFiles(repository.path, ref, [ISSUE_TRACKER, ...INSTRUCTIONS]);
    files = new Map(read.files.map(({ path, content }) => [path, content]));
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return unchecked(repository, checkedAt, `couldn’t read ${ref} (${error.message})`);
  }
  const missing = [
    ...(files.has(ISSUE_TRACKER) ? [] : [ISSUE_TRACKER]),
    ...(INSTRUCTIONS.some((path) => AGENT_SKILLS.test(files.get(path) ?? '')) ? [] : ['an `## Agent skills` block in AGENTS.md or CLAUDE.md']),
  ];
  if (missing.length === 0) return { present: true, checkedAt };
  return {
    present: false,
    checkedAt,
    reason: `${id} has no setup for the skill set on ${baseBranch} (missing ${missing.join(' and ')}): its skills won’t find the issue tracker and labels they expect.`,
    failed: false,
  };
}

// A check that couldn't look, and why: the setup may well be there.
export function unchecked({ id }: Repository, checkedAt: number, why: string): SkillsSetup {
  return { present: false, checkedAt, reason: `The factory couldn’t check the skill set’s setup in ${id}: ${why}.`, failed: true };
}
