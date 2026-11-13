// The leftover matcher (ADR 0003, ADR 0011): what a task tree left behind
// that belongs to no live task. `factory gc` lists what it finds and deletes
// only what the operator ticks. It reads the store and the world and
// deletes nothing itself, so the Factory recovered report lists what it
// finds after an unclean start too (ADR 0003). A task is live until it is Done or
// Cancelled and its own cleanup is through: until then, what it has is its
// cleanup's to remove.
import { relative, isAbsolute } from 'node:path';
import { GitError, type Git } from '../git/git.ts';
import { isTerminal, keptChildBranches, type Lifecycle, type Task, type TaskWorktree } from '../lifecycle/lifecycle.ts';
import type { Leftover, LeftoversView } from '../protocol/protocol.ts';
import { SandboxError, type ImageListing, type Sandbox } from '../sandbox/sandbox.ts';

// The task branches the factory cuts, and so the only local and remote
// branches it calls its own.
const FACTORY_BRANCHES = 'factory/';

// The order `gc` deletes leftovers in: a container before the image it
// used, a worktree before the branch it has checked out.
export const DELETION_ORDER: readonly Leftover['kind'][] = ['container', 'worktree', 'branch', 'remote-branch', 'image'];

// Whether the two name the same leftover.
export function sameLeftover(a: Leftover, b: Leftover): boolean {
  return identity(a) === identity(b);
}

function identity(leftover: Leftover): string {
  switch (leftover.kind) {
    case 'worktree':
      return `worktree ${leftover.repo} ${leftover.path}`;
    case 'branch':
    case 'remote-branch':
      return `${leftover.kind} ${leftover.repo} ${leftover.branch}`;
    case 'container':
      return `container ${leftover.taskId}`;
    case 'image':
      return `image ${leftover.image}`;
  }
}

// The leftovers in a sentence, as a refusal names them.
export function listedLeftovers(leftovers: Leftover[]): string {
  const items = leftovers.map((leftover) => {
    switch (leftover.kind) {
      case 'worktree':
        return `the worktree at ${leftover.path}`;
      case 'branch':
        return `the branch ${leftover.branch}`;
      case 'remote-branch':
        return `the branch ${leftover.branch} on origin`;
      case 'container':
        return `${leftover.taskId}’s container`;
      case 'image':
        return `the image ${leftover.image}`;
    }
  });
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('');
}

// What the matcher looks at, as found.
export type World = {
  worktrees: { repo: string; path: string; branch: string }[];
  branches: { repo: string; branch: string }[];
  // Origin's, on GitHub.
  remoteBranches: { repo: string; branch: string }[];
  // The factory's containers, by task, and its sandbox images.
  containers: string[];
  images: ImageListing[];
  unlisted: string[];
};

// Lists what the matcher looks at: each registered repository's worktrees
// under `worktreeRoot` and its local and origin's `factory/*` branches. A
// repository whose clone is missing is skipped, and said so, as is an
// origin that can't be reached; then the factory's containers and images,
// unless Docker can't be reached. Without `origin`, origin isn't asked, as
// at start-up, where the network may be down. With `repo`, only that
// repository is looked at, and only the containers of its known tasks: an
// image, or a container of no task the factory knows, is no repository's.
export async function lookAround(
  { git, sandbox }: { git: Git; sandbox: Sandbox },
  lifecycle: Lifecycle,
  worktreeRoot: string,
  { origin = true, repo: scope }: { origin?: boolean; repo?: string } = {},
): Promise<World> {
  const world: World = { worktrees: [], branches: [], remoteBranches: [], containers: [], images: [], unlisted: [] };
  for (const repository of Object.values(lifecycle.repositories)) {
    if (scope !== undefined && repository.id !== scope) continue;
    const repo = repository.id;
    if (repository.missing) {
      world.unlisted.push(`${repo}’s clone is missing, so its worktrees and branches weren’t looked at.`);
      continue;
    }
    try {
      for (const worktree of await git.worktrees(repository.path)) {
        if (isWithin(worktreeRoot, worktree.path)) world.worktrees.push({ repo, path: worktree.path, branch: worktree.branch });
      }
      for (const branch of await git.branches(repository.path, FACTORY_BRANCHES)) world.branches.push({ repo, branch });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      world.unlisted.push(`${repo}’s worktrees and branches couldn’t be read: ${error.message}`);
      continue;
    }
    if (!origin) continue;
    try {
      for (const branch of await git.originBranches(repository.path, FACTORY_BRANCHES)) world.remoteBranches.push({ repo, branch });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      world.unlisted.push(`${repo}’s branches on origin couldn’t be read: ${error.message}`);
    }
  }
  try {
    const containers = (await sandbox.list()).map(({ taskId }) => taskId);
    world.containers = scope === undefined ? containers : containers.filter((taskId) => lifecycle.tasks[taskId]?.repo === scope);
    world.images = scope === undefined ? await sandbox.images() : [];
  } catch (error) {
    if (!(error instanceof SandboxError)) throw error;
    world.containers = [];
    world.images = [];
    world.unlisted.push(`Docker couldn’t be reached, so containers and images weren’t looked at: ${error.message}`);
  }
  return world;
}

// What in `world` belongs to no live task, each with why.
export function matchLeftovers(lifecycle: Lifecycle, world: World): LeftoversView {
  const tasks = Object.values(lifecycle.tasks);
  const live = tasks.filter(isLive);
  // The worktrees and branches live tasks have, and those a spawn or a
  // ticket task's launch under way cut or is about to (ADR 0003), and the
  // children's branches kept for their parent's merge or their root's
  // cleanup (ADR 0011).
  const held: { repo: string; worktree: TaskWorktree }[] = [];
  for (const task of [...live, ...keptChildBranches(tasks)]) if (task.worktree) held.push({ repo: task.repo, worktree: task.worktree });
  for (const intent of Object.values(lifecycle.intents)) {
    const parent = lifecycle.tasks[intent.taskId];
    if (intent.verb === 'spawn' && parent) held.push({ repo: parent.repo, worktree: intent.spawn.worktree });
    if (intent.verb === 'launch' && parent) held.push({ repo: parent.repo, worktree: intent.launch.worktree });
  }
  const holdsPath = (repo: string, path: string) => held.some((owned) => owned.repo === repo && samePath(owned.worktree.path, path));
  const holdsBranch = (repo: string, branch: string) => held.some((owned) => owned.repo === repo && owned.worktree.branch === branch);
  // Why it is a leftover: the ended task it was, or none.
  const why = (task: Task | undefined) => (task ? `${task.id} is ${task.state === 'done' ? 'Done' : 'Cancelled'}.` : 'No task of the factory’s has it.');
  const leftovers: LeftoversView['leftovers'] = [];
  const add = (leftover: Leftover, task: Task | undefined) => leftovers.push({ leftover, why: why(task) });
  for (const { repo, path, branch } of world.worktrees) {
    if (holdsPath(repo, path) || holdsBranch(repo, branch)) continue;
    add({ kind: 'worktree', repo, path, branch }, tasks.find((task) => task.repo === repo && task.worktree && samePath(task.worktree.path, path)));
  }
  for (const { repo, branch } of world.branches) {
    if (holdsBranch(repo, branch)) continue;
    add({ kind: 'branch', repo, branch }, tasks.find((task) => task.repo === repo && task.worktree?.branch === branch));
  }
  for (const { repo, branch } of world.remoteBranches) {
    if (holdsBranch(repo, branch)) continue;
    add({ kind: 'remote-branch', repo, branch }, tasks.find((task) => task.repo === repo && task.worktree?.branch === branch));
  }
  const liveIds = new Set(live.map((task) => task.id));
  for (const taskId of world.containers) {
    // Recovery only stops such a container, since its clone may hold L2
    // commits that never came out (ADR 0003): ticked, it goes with them.
    if (!liveIds.has(taskId)) leftovers.push({ leftover: { kind: 'container', taskId }, why: `${why(lifecycle.tasks[taskId])} Its clone may hold commits that never came out.` });
  }
  // An image of an older version goes once no live task's container uses
  // it: a leftover container that does goes first.
  for (const { image, current, usedBy } of world.images) {
    if (!current && !usedBy.some((taskId) => liveIds.has(taskId))) leftovers.push({ leftover: { kind: 'image', image }, why: 'An older sandbox image no live task’s container uses.' });
  }
  return { leftovers, unlisted: world.unlisted };
}

// Whether the task still has what it was given: it is unfinished, or its
// cleanup is under way.
function isLive(task: Task): boolean {
  return !isTerminal(task) || !!task.cleanup;
}

function isWithin(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}
