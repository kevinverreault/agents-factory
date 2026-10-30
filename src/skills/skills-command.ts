// `agents-factory skills update` and `skills status` (ADR 0005). Both work on
// the lock and the upstream cache directly: the daemon only reads the lock
// when a task launches.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { FactoryPaths } from '../daemon/paths.ts';
import { skillSetManager, type SkillSetLock, type SkillSetStatus, type SkillSetUpdate } from './skill-set.ts';

export async function skillsCommand(verb: 'update' | 'status', paths: FactoryPaths): Promise<number> {
  const skills = skillSetManager({ root: paths.skillsRoot, lockPath: paths.skillsLock });
  if (verb === 'status') {
    const personalDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills');
    console.log(describeStatus(await skills.status(personalDir), personalDir));
    return 0;
  }
  console.log(`Fetching ${skills.lock().upstream}…`);
  const update = await skills.planUpdate();
  console.log(describeUpdate(update));
  if (update.from === update.to) return 0;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Bump the pin to ${short(update.to)}? Only tasks launched from now on use it. [y/N] `).catch(() => '');
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log(`The pin stays at ${short(update.from)}.`);
    return 0;
  }
  skills.bump(update);
  console.log(`Pinned ${update.upstream} at ${short(update.to)}.`);
  return 0;
}

function describeUpdate({ from, to, commits, changed }: SkillSetUpdate): string {
  if (from === to) return `The pin ${short(from)} is upstream's head: nothing to update.`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    commits.length
      ? `Pinned at ${short(from)}. Upstream is at ${short(to)}, ${plural(commits.length, 'commit')} on:`
      : `Pinned at ${short(from)}, which upstream's head ${short(to)} doesn't contain.`,
    ...commits.map(({ sha, subject }) => `  ${short(sha)} ${subject}`),
    changed.length ? `${plural(changed.length, 'skill')} changed:` : 'No skill changed.',
    ...changed.map(({ skill, change }) => `  ${change.padEnd(8)} ${skill}`),
  ].join('\n');
}

function describeStatus({ lock, skills }: SkillSetStatus, personalDir: string): string {
  const width = Math.max(...skills.map(({ skill }) => skill.length));
  const copies = skills.filter(({ personal }) => personal);
  return [
    `The skill set is pinned at ${pin(lock)}.`,
    copies.length
      ? `${copies.length} of its ${skills.length} skills have a personal copy in ${personalDir}. AFK runs never load them; HITL runs may, when one skill calls another:`
      : `None of its ${skills.length} skills has a personal copy in ${personalDir}.`,
    ...(copies.length
      ? skills.map(({ skill, personal }) => {
          const state = !personal
            ? 'no personal copy'
            : personal.differences.length === 0
              ? 'same as the pin'
              : `differs: ${personal.differences.map(({ file, change }) => `${file} ${change}`).join(', ')}`;
          return `  ${skill.padEnd(width)}  ${state}`;
        })
      : []),
  ].join('\n');
}

const short = (sha: string) => sha.slice(0, 7);
const pin = ({ upstream, sha }: SkillSetLock) => `${upstream.replace(/\.git$/, '')}@${short(sha)}`;
