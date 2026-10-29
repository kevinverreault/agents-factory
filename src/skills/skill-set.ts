// The skill set manager (ADR 0005): one global pin on an upstream skill
// library, built with the factory's own skills into a content-hashed local
// plugin named `factory`. Upstream is read from a bare cache clone, so a
// built pin needs no network, and `skills update` can show what changed.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillSetLock = { upstream: string; sha: string };

// A built skill set: its version is the hash of its content.
export type SkillSetVersion = { version: string; path: string };

// What the daemon needs: the version a launching task freezes, where a
// version lives, and removing the versions no unfinished task references.
export interface SkillSets {
  // Builds the skill set the lock pins now, unless it is built already.
  current(): Promise<SkillSetVersion>;
  pathOf(version: string): string;
  // Removes every built version not in `keep`.
  prune(keep: Iterable<string>): Promise<void>;
}

export type SkillChange = 'added' | 'changed' | 'removed';

export type SkillSetUpdate = {
  upstream: string;
  from: string;
  to: string;
  // Newest first.
  commits: { sha: string; subject: string }[];
  changed: { skill: string; change: SkillChange }[];
};

export type PersonalDifference = { file: string; change: 'changed' | 'only in the personal copy' | 'only in the pin' };

export type SkillSetStatus = {
  lock: SkillSetLock;
  skills: { skill: string; personal: { path: string; differences: PersonalDifference[] } | null }[];
};

export interface SkillSetManager extends SkillSets {
  lock(): SkillSetLock;
  // Fetches upstream and says what moving the pin to its head would change.
  // The lock is left alone.
  planUpdate(): Promise<SkillSetUpdate>;
  // Moves the pin to the update's head. Only tasks launched later pick it up.
  bump(update: SkillSetUpdate): void;
  // How the operator's personal copies, in `personalDir`, differ from the pin.
  status(personalDir: string): Promise<SkillSetStatus>;
}

export const DEFAULT_LOCK: SkillSetLock = {
  upstream: 'https://github.com/mattpocock/skills.git',
  sha: '49dd158d1076134a641b33efb035946536778336',
};

// The factory's own skills, shipped in the package.
export const FACTORY_SKILLS = fileURLToPath(new URL('./factory/', import.meta.url));

// A skill's files by their path inside the skill, and skills by name.
type Files = Map<string, Buffer>;
type Skills = Map<string, Files>;

const VERSION = /^[0-9a-f]{16}$/;
const UPSTREAM_REF = 'refs/factory/upstream';

export function skillSetManager({
  root,
  lockPath,
  factorySkills = FACTORY_SKILLS,
}: {
  // Where built versions and the upstream cache live.
  root: string;
  lockPath: string;
  factorySkills?: string;
}): SkillSetManager {
  const cache = join(root, 'upstream.git');
  // Upstream skills by commit: a commit never changes.
  const read = new Map<string, Promise<Skills>>();

  function lock(): SkillSetLock {
    if (!existsSync(lockPath)) return DEFAULT_LOCK;
    const { upstream, sha } = JSON.parse(readFileSync(lockPath, 'utf8')) as SkillSetLock;
    return { upstream, sha };
  }

  async function ensureCache(): Promise<void> {
    if (existsSync(cache)) return;
    mkdirSync(root, { recursive: true });
    await git(root, 'init', '--quiet', '--bare', cache);
  }

  // Brings upstream's default branch into the cache, and returns its head.
  async function fetchHead(upstream: string): Promise<string> {
    await ensureCache();
    await git(cache, 'fetch', '--quiet', '--no-tags', upstream, `+HEAD:${UPSTREAM_REF}`);
    return (await git(cache, 'rev-parse', UPSTREAM_REF)).toString().trim();
  }

  // The full commit `sha` names, fetching upstream if the cache lacks it.
  async function resolve({ upstream, sha }: SkillSetLock): Promise<string> {
    await ensureCache();
    const local = () => git(cache, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`).then((out) => out.toString().trim(), () => null);
    let commit = await local();
    if (commit) return commit;
    await fetchHead(upstream);
    // A pin off the default branch can still be fetched by its full hash.
    if (!(commit = await local()) && /^[0-9a-f]{40}$/.test(sha)) {
      await git(cache, 'fetch', '--quiet', '--no-tags', upstream, sha).catch(() => {});
      commit = await local();
    }
    if (!commit) throw new Error(`${upstream} has no commit ${sha}.`);
    return commit;
  }

  function upstreamSkills(commit: string): Promise<Skills> {
    let skills = read.get(commit);
    if (!skills) read.set(commit, (skills = readUpstream(cache, commit)));
    return skills;
  }

  // The pinned upstream skills with the factory's own layered on top.
  async function pinned(): Promise<{ lock: SkillSetLock; skills: Skills }> {
    const pin = lock();
    const skills = new Map(await upstreamSkills(await resolve(pin)));
    for (const [name, files] of readSkillsDir(factorySkills)) {
      if (skills.has(name)) throw new Error(`The factory skill ${name} reuses the name of an upstream skill.`);
      skills.set(name, files);
    }
    return { lock: pin, skills };
  }

  return {
    lock,

    async current() {
      const plugin = pluginFiles((await pinned()).skills);
      const version = hashOf(plugin);
      const path = join(root, version);
      if (!existsSync(path)) {
        // Written aside and renamed, so a version directory is never half there.
        const building = join(root, `.building-${randomUUID()}`);
        for (const [file, content] of plugin) {
          mkdirSync(dirname(join(building, file)), { recursive: true });
          writeFileSync(join(building, file), content);
        }
        try {
          renameSync(building, path);
        } catch (error) {
          rmSync(building, { recursive: true, force: true });
          if (!existsSync(path)) throw error;
        }
      }
      return { version, path };
    },

    pathOf: (version) => join(root, version),

    async prune(keep) {
      const kept = new Set(keep);
      if (!existsSync(root)) return;
      for (const name of readdirSync(root)) {
        if (!VERSION.test(name) || kept.has(name)) continue;
        // A version a CLI still has open goes at the next prune instead.
        try {
          rmSync(join(root, name), { recursive: true, force: true });
        } catch {}
      }
    },

    async planUpdate() {
      const pin = lock();
      const from = await resolve(pin);
      const to = await fetchHead(pin.upstream);
      const log = (await git(cache, 'log', '--format=%H%x09%s', `${from}..${to}`)).toString().trim();
      const commits = log ? log.split('\n').map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) })) : [];
      const [before, after] = await Promise.all([upstreamSkills(from), upstreamSkills(to)]);
      const changed: SkillSetUpdate['changed'] = [];
      for (const skill of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const was = before.get(skill);
        const is = after.get(skill);
        if (!was) changed.push({ skill, change: 'added' });
        else if (!is) changed.push({ skill, change: 'removed' });
        else if (compare(was, is).length) changed.push({ skill, change: 'changed' });
      }
      return { upstream: pin.upstream, from, to, commits, changed };
    },

    bump({ upstream, to }) {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, `${JSON.stringify({ upstream, sha: to }, null, 2)}\n`);
    },

    async status(personalDir) {
      const { lock, skills } = await pinned();
      return {
        lock,
        skills: [...skills.keys()].sort().map((skill) => {
          const path = join(personalDir, skill);
          if (!isDirectory(path)) return { skill, personal: null };
          const differences = compare(skills.get(skill)!, readFiles(path)).map(({ file, change }) => ({
            file,
            change: change === 'added' ? 'only in the personal copy' : change === 'removed' ? 'only in the pin' : 'changed',
          })) satisfies PersonalDifference[];
          return { skill, personal: { path, differences } };
        }),
      };
    },
  };
}

// The files `after` adds, changes or removes from `before`, by path. Line
// endings don't count: a checkout on Windows may have turned LF into CRLF.
function compare(before: Files, after: Files): { file: string; change: SkillChange }[] {
  const text = (content: Buffer) => content.toString('latin1').replaceAll('\r\n', '\n');
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((file): { file: string; change: SkillChange }[] => {
    const was = before.get(file);
    const is = after.get(file);
    if (!was) return [{ file, change: 'added' }];
    if (!is) return [{ file, change: 'removed' }];
    return text(was) === text(is) ? [] : [{ file, change: 'changed' }];
  });
}

// The plugin's files by path: its manifest, then each skill under `skills/<name>/`.
function pluginFiles(skills: Skills): Files {
  const manifest = { name: 'factory', description: 'The skill set the agent factory pins for its runs.' };
  const files: Files = new Map([['.claude-plugin/plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]);
  for (const [name, skill] of skills) for (const [file, content] of skill) files.set(`skills/${name}/${file}`, content);
  return files;
}

function hashOf(files: Files): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    const content = files.get(path)!;
    hash.update(`${path}\0${content.length}\0`).update(content);
  }
  return hash.digest('hex').slice(0, 16);
}

// The skills upstream promotes at `commit`: those its own plugin manifest lists.
async function readUpstream(cache: string, commit: string): Promise<Skills> {
  let listed: unknown;
  try {
    listed = JSON.parse((await git(cache, 'show', `${commit}:.claude-plugin/plugin.json`)).toString()).skills;
  } catch {}
  if (!Array.isArray(listed) || !listed.every((path) => typeof path === 'string')) {
    throw new Error(`Upstream has no .claude-plugin/plugin.json listing its skills at ${commit}.`);
  }
  const dirs = listed.map((path) => path.replace(/^\.\//, '').replace(/\/$/, ''));
  const entries = (await git(cache, 'ls-tree', '-r', '-z', commit, '--', ...dirs))
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t') as [string, string];
      const [mode, type, oid] = meta.split(' ') as [string, string, string];
      return { mode, type, oid, path };
    })
    // Symlinks and submodules aren't skill files.
    .filter(({ type, mode }) => type === 'blob' && mode !== '120000');
  const blobs = await readBlobs(cache, entries.map(({ oid }) => oid));
  const skills: Skills = new Map(dirs.map((dir) => [dir.slice(dir.lastIndexOf('/') + 1), new Map()]));
  for (const { oid, path } of entries) {
    const dir = dirs.find((dir) => path.startsWith(`${dir}/`))!;
    skills.get(dir.slice(dir.lastIndexOf('/') + 1))!.set(path.slice(dir.length + 1), blobs.get(oid)!);
  }
  // A listed skill the commit doesn't have isn't there.
  for (const [name, files] of skills) if (files.size === 0) skills.delete(name);
  return skills;
}

// Each blob's content, by id, in one `git cat-file --batch`.
async function readBlobs(cache: string, oids: string[]): Promise<Map<string, Buffer>> {
  const out = await git(cache, { input: oids.join('\n') + '\n' }, 'cat-file', '--batch');
  const blobs = new Map<string, Buffer>();
  for (let at = 0; at < out.length; ) {
    const end = out.indexOf(0x0a, at);
    const [oid, , size] = out.subarray(at, end).toString().split(' ') as [string, string, string];
    blobs.set(oid, out.subarray(end + 1, end + 1 + Number(size)));
    at = end + 1 + Number(size) + 1;
  }
  return blobs;
}

// Each directory under `dir` that holds a SKILL.md, by its name.
function readSkillsDir(dir: string): Skills {
  if (!isDirectory(dir)) return new Map();
  return new Map(
    readdirSync(dir)
      .filter((name) => existsSync(join(dir, name, 'SKILL.md')))
      .sort()
      .map((name) => [name, readFiles(join(dir, name))]),
  );
}

// Every file under `dir`, symlinks followed, by its path with forward slashes.
function readFiles(dir: string, prefix = ''): Files {
  const files: Files = new Map();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (isDirectory(path)) for (const [file, content] of readFiles(path, `${prefix}${name}/`)) files.set(file, content);
    else files.set(`${prefix}${name}`, readFileSync(path));
  }
  return files;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The command's output. Throws with git's own message when it fails.
function git(cwd: string, ...args: string[]): Promise<Buffer>;
function git(cwd: string, options: { input: string }, ...args: string[]): Promise<Buffer>;
function git(cwd: string, ...rest: (string | { input: string })[]): Promise<Buffer> {
  const input = typeof rest[0] === 'object' ? (rest.shift() as { input: string }).input : null;
  const args = rest as string[];
  return new Promise((done, fail) => {
    const child = execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => (error ? fail(new Error(stderr.toString().trim() || error.message)) : done(stdout)),
    );
    if (input !== null) child.stdin!.end(input);
  });
}
