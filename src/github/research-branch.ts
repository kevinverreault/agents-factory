// The research branch (ADR 0007): the one exception to "no code leaves
// this machine". A research child works on `research/<name>`, and the
// factory pushes it only when its outgoing commits touch nothing but
// `docs/research/**`. Every rule about research branches lives here.

// Where a research child's findings go, and the only paths its push may change.
export const RESEARCH_DOCS = 'docs/research/';

// The branch a research child named `name` works on.
export function researchBranch(name: string): string {
  return `research/${name}`;
}

// Whether `branch` is a research branch: `research/` and a name of letters,
// digits, dots, dashes and underscores, starting with no dot or dash, that
// git takes as a branch (no `..`, no `.lock` ending).
export function isResearchBranch(branch: string): boolean {
  return /^research\/\w[\w.-]*$/.test(branch) && !branch.includes('..') && !branch.endsWith('.lock');
}

// Why `name` can't name a research branch, or null.
export function researchNameRefusal(name: string): string | null {
  const branch = researchBranch(name);
  return isResearchBranch(branch)
    ? null
    : `${branch} can’t be a research branch: name it with letters, digits, dots, dashes and underscores, such as oauth-scopes.`;
}

// The paths a research branch's outgoing commits change outside
// `docs/research/`, which block its push. None for any other branch.
export function outsideResearch(branch: string, paths: string[]): string[] {
  return isResearchBranch(branch) ? paths.filter((path) => !path.startsWith(RESEARCH_DOCS)) : [];
}
