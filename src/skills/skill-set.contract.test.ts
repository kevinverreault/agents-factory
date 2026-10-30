// Seam 3: the skill set manager against a throwaway upstream git repository
// in a temp directory, standing in for `mattpocock/skills` (ADR 0005).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_LOCK, skillSetManager } from './skill-set.ts';
import { describeSkillSetsContract } from './skill-sets-contract.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name}.\n---\n\n${body}\n`;

// An upstream skill library laid out as `mattpocock/skills` is: skills in
// category folders, the promoted ones listed in its own plugin manifest.
function upstreamRepo() {
  const dir = tempDir('factory-upstream-');
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  run('init', '--quiet', '--initial-branch', 'main');
  run('config', 'user.email', 'matt@example.com');
  run('config', 'user.name', 'Matt');
  run('config', 'core.autocrlf', 'false');
  const manifest = (skills: string[]) =>
    JSON.stringify({ name: 'mattpocock-skills', skills: skills.map((path) => `./skills/${path}`) }, null, 2);
  return {
    url: dir,
    manifest,
    // Writes the files (null deletes one), commits them, and returns the commit.
    commit(subject: string, files: Record<string, string | null>): string {
      for (const [path, content] of Object.entries(files)) {
        if (content === null) rmSync(join(dir, path));
        else writeFiles(dir, { [path]: content });
      }
      run('add', '--all');
      run('commit', '--quiet', '-m', subject);
      return run('rev-parse', 'HEAD');
    },
  };
}

// The pinned upstream: `implement` and `research` promoted, `loop-me` still in progress.
function pinnedUpstream() {
  const upstream = upstreamRepo();
  const pin = upstream.commit('Initial skills', {
    '.claude-plugin/plugin.json': upstream.manifest(['engineering/implement', 'engineering/research']),
    'README.md': 'Skills.\n',
    'skills/engineering/implement/SKILL.md': skill('implement', 'Implement the work.'),
    'skills/engineering/implement/agents/openai.yaml': 'name: implement\n',
    'skills/engineering/research/SKILL.md': skill('research', 'Research the question.'),
    'skills/in-progress/loop-me/SKILL.md': skill('loop-me', 'Not promoted yet.'),
  });
  return { upstream, pin };
}

function factorySkills(files: Record<string, string> = { 'quick-grill/SKILL.md': skill('quick-grill', 'Ask at most three questions.') }) {
  const dir = tempDir('factory-own-skills-');
  writeFiles(dir, { 'README.md': 'The factory’s own skills.\n', ...files });
  return dir;
}

function manager(upstream: { url: string }, sha: string, factory = factorySkills()) {
  const home = tempDir('factory-skills-home-');
  const lockPath = join(home, 'skills.lock');
  writeFileSync(lockPath, JSON.stringify({ upstream: upstream.url, sha }));
  const options = { root: join(home, 'skills'), lockPath, factorySkills: factory };
  // `again` is another manager over the same files, as the next daemon would be.
  return { skills: skillSetManager(options), again: () => skillSetManager(options), home, lockPath };
}

// Every file under `dir`, by its path relative to it with forward slashes.
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(dir.length + 1).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
    }
  }
  return files;
}

describe('building the skill set', () => {
  test('the pinned upstream skills and the factory skills are built into one local plugin named factory', async () => {
    const { pin, upstream } = pinnedUpstream();
    const { skills } = manager(upstream, pin);

    const { path } = await skills.current();

    expect(tree(path)).toEqual({
      '.claude-plugin/plugin.json': expect.any(String),
      'skills/implement/SKILL.md': skill('implement', 'Implement the work.'),
      'skills/implement/agents/openai.yaml': 'name: implement\n',
      'skills/research/SKILL.md': skill('research', 'Research the question.'),
      'skills/quick-grill/SKILL.md': skill('quick-grill', 'Ask at most three questions.'),
    });
    expect(JSON.parse(readFileSync(join(path, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'factory' });
  });

  test('the version is a hash of the content: an upstream commit that changes no skill keeps it, one that does gets a new one', async () => {
    const { pin, upstream } = pinnedUpstream();
    const readmeOnly = upstream.commit('Reword the README', { 'README.md': 'Better skills.\n' });
    const reworded = upstream.commit('Reword implement', {
      'skills/engineering/implement/SKILL.md': skill('implement', 'Implement the work, test first.'),
    });

    const atPin = await manager(upstream, pin).skills.current();
    const atReadme = await manager(upstream, readmeOnly).skills.current();
    const atReworded = await manager(upstream, reworded).skills.current();

    expect(atPin.version).toMatch(/^[0-9a-f]{16}$/);
    expect(atReadme.version).toBe(atPin.version);
    expect(atReworded.version).not.toBe(atPin.version);
  });

  test('a factory skill change gives a new version too', async () => {
    const { pin, upstream } = pinnedUpstream();

    const before = await manager(upstream, pin).skills.current();
    const after = await manager(upstream, pin, factorySkills({ 'quick-grill/SKILL.md': skill('quick-grill', 'Ask one question.') })).skills.current();

    expect(after.version).not.toBe(before.version);
  });

  test('a factory skill that reuses an upstream name is refused', async () => {
    const { pin, upstream } = pinnedUpstream();
    const { skills } = manager(upstream, pin, factorySkills({ 'research/SKILL.md': skill('research', 'Our own research.') }));

    await expect(skills.current()).rejects.toThrow('The factory skill research reuses the name of an upstream skill.');
  });

  test('a pin the upstream does not have is refused with a reason', async () => {
    const { upstream } = pinnedUpstream();
    const { skills } = manager(upstream, '0123456789abcdef0123456789abcdef01234567');

    await expect(skills.current()).rejects.toThrow(`${upstream.url} has no commit 0123456789abcdef0123456789abcdef01234567.`);
  });

  test('without a lock the pin is mattpocock/skills at 49dd158', () => {
    const home = tempDir('factory-skills-home-');
    const skills = skillSetManager({ root: join(home, 'skills'), lockPath: join(home, 'skills.lock') });

    expect(skills.lock()).toEqual(DEFAULT_LOCK);
    expect(DEFAULT_LOCK).toEqual({ upstream: 'https://github.com/mattpocock/skills.git', sha: expect.stringMatching(/^49dd158[0-9a-f]{33}$/) });
  });
});

describeSkillSetsContract('the skill set manager', async () => {
  const { pin, upstream } = pinnedUpstream();
  const { skills, lockPath } = manager(upstream, pin);
  let rewordings = 0;
  return {
    skillSets: skills,
    async movePin() {
      const sha = upstream.commit('Reword research', {
        'skills/engineering/research/SKILL.md': skill('research', `Research, take ${++rewordings}.`),
      });
      writeFileSync(lockPath, JSON.stringify({ upstream: upstream.url, sha }));
    },
    isBuilt: (version) => existsSync(skills.pathOf(version)),
    async dispose() {},
  };
});

describe('keeping versions', () => {
  test('pruning leaves the upstream cache, so a pin already fetched builds again offline', async () => {
    const { pin, upstream } = pinnedUpstream();
    const later = upstream.commit('Reword research', { 'skills/engineering/research/SKILL.md': skill('research', 'Research harder.') });
    const { skills, again, lockPath } = manager(upstream, pin);
    const old = await skills.current();
    writeFileSync(lockPath, JSON.stringify({ upstream: upstream.url, sha: later }));
    const current = await skills.current();

    await skills.prune([old.version]);

    expect(existsSync(skills.pathOf(old.version))).toBe(true);
    expect(existsSync(skills.pathOf(current.version))).toBe(false);
    // The upstream cache isn't a version: the next build needs no fetch.
    rmSync(upstream.url, { recursive: true, force: true });
    expect((await again().current()).version).toBe(current.version);
  });
});

describe('skills update', () => {
  test('lists the commits and changed skills since the pin, and bumps the lock only when asked', async () => {
    const { pin, upstream } = pinnedUpstream();
    upstream.commit('Reword the README', { 'README.md': 'Better skills.\n' });
    upstream.commit('Reword implement', { 'skills/engineering/implement/SKILL.md': skill('implement', 'Implement, test first.') });
    const head = upstream.commit('Promote loop-me, retire research', {
      '.claude-plugin/plugin.json': upstream.manifest(['engineering/implement', 'in-progress/loop-me']),
      'skills/engineering/research/SKILL.md': null,
    });
    const { skills, lockPath } = manager(upstream, pin);
    const before = await skills.current();

    const update = await skills.planUpdate();

    expect(update).toEqual({
      upstream: upstream.url,
      from: pin,
      to: head,
      commits: [
        { sha: head, subject: 'Promote loop-me, retire research' },
        { sha: expect.any(String), subject: 'Reword implement' },
        { sha: expect.any(String), subject: 'Reword the README' },
      ],
      changed: [
        { skill: 'implement', change: 'changed' },
        { skill: 'loop-me', change: 'added' },
        { skill: 'research', change: 'removed' },
      ],
    });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).sha).toBe(pin);
    expect((await skills.current()).version).toBe(before.version);

    skills.bump(update);

    expect(skills.lock()).toEqual({ upstream: upstream.url, sha: head });
    const after = await skills.current();
    expect(after.version).not.toBe(before.version);
    expect(Object.keys(tree(join(after.path, 'skills')))).toEqual(
      expect.arrayContaining(['implement/SKILL.md', 'loop-me/SKILL.md', 'quick-grill/SKILL.md']),
    );
  });

  test('an upstream with nothing new reports no commits', async () => {
    const { pin, upstream } = pinnedUpstream();

    expect(await manager(upstream, pin).skills.planUpdate()).toMatchObject({ from: pin, to: pin, commits: [], changed: [] });
  });
});

describe('skills status', () => {
  test('reports, for each skill in the pin, whether a personal copy exists and how it differs', async () => {
    const { pin, upstream } = pinnedUpstream();
    const { skills } = manager(upstream, pin);
    const personal = tempDir('factory-personal-skills-');
    writeFiles(personal, {
      // The same text with Windows line endings is the same copy.
      'implement/SKILL.md': skill('implement', 'Implement the work.').replaceAll('\n', '\r\n'),
      'implement/agents/openai.yaml': 'name: implement\n',
      'research/SKILL.md': skill('research', 'My own research.'),
      'research/NOTES.md': 'Mine.\n',
      'recette/SKILL.md': skill('recette', 'Not in the skill set.'),
    });

    expect(await skills.status(personal)).toEqual({
      lock: { upstream: upstream.url, sha: pin },
      skills: [
        { skill: 'implement', personal: { path: join(personal, 'implement'), differences: [] } },
        { skill: 'quick-grill', personal: null },
        {
          skill: 'research',
          personal: {
            path: join(personal, 'research'),
            differences: [
              { file: 'NOTES.md', change: 'only in the personal copy' },
              { file: 'SKILL.md', change: 'changed' },
            ],
          },
        },
      ],
    });
  });

  test('without a personal skills directory no skill has a personal copy', async () => {
    const { pin, upstream } = pinnedUpstream();
    const { skills, home } = manager(upstream, pin);

    const { skills: rows } = await skills.status(join(home, 'no-such-dir'));

    expect(rows.map((row) => row.personal)).toEqual([null, null, null]);
  });
});
