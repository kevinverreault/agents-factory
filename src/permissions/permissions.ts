// The L1 gate's rules (ADR 0007): which tool calls an AFK run may make
// without asking the operator. They come from the factory's own allow list,
// the operator's permissions file and the task, never from the target repo.
// Rules use Claude Code's syntax: `Tool`, or `Tool(specifier)`. Bash rules
// are best-effort, not a security boundary: L1 guards against accidents.
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { parse } from 'yaml';
import { readCommandLine, type SimpleCommand } from './shell.ts';

// A tool call Claude Code asked about. `summary` is what it is pointed at, on one line.
export type ToolCall = { id: string; tool: string; input: Record<string, unknown>; summary: string };

// The factory's allow list: what it lets every L1 run do without asking,
// each entry with why that is safe enough for L1, which guards against
// accidents, not malice (ADR 0007). It is these rules, which Claude Code
// matches itself, and the factory's commands below, which no rule's glob
// can say. Edits in the worktree are accepted by the run's permission mode,
// and Claude Code runs what it considers read-only without asking. The
// factory's MCP tools join once L1 runs get the factory server, gated on
// its provenance.
export const FACTORY_ALLOW_LIST: readonly string[] = [
  // Read-only tools, and the agent's own bookkeeping.
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'Task',
  'Agent',
  'Skill',
  'WebFetch',
  'WebSearch',
  // Read-only and local-commit git.
  ...['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'grep', 'add', 'commit'].map((verb) => `Bash(git ${verb} *)`),
  'Bash(git branch --show-current)',
  // Reads of git config, by the options that read and never write. A key
  // alone is a read too, which the factory's matcher tells from a write.
  ...['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'].map((read) => `Bash(git config ${read} *)`),
  // Reading issues and PRs, which an AFK run does as the App's bot with its
  // read-only token (ADR 0004).
  ...['issue view', 'issue list', 'pr view', 'pr list', 'pr diff'].map((verb) => `Bash(gh ${verb} *)`),
  // Package-manager scripts and test runners.
  ...['npm', 'pnpm', 'yarn'].flatMap((manager) => [`Bash(${manager} test *)`, `Bash(${manager} run *)`]),
  ...['vitest', 'jest', 'tsc', 'eslint'].map((runner) => `Bash(npx ${runner} *)`),
  'Bash(pytest *)',
  'Bash(python -m pytest *)',
  'Bash(cargo test *)',
  'Bash(cargo build *)',
  'Bash(go test *)',
  'Bash(go build *)',
  'Bash(dotnet test *)',
  'Bash(dotnet build *)',
  // Installs from the lockfile only, which fetch what the project pinned and
  // never change what it depends on. An install that names a package, or
  // one that may move the lockfile, still asks.
  'Bash(npm ci *)',
  'Bash(pnpm install --frozen-lockfile *)',
  'Bash(yarn install --immutable *)',
  'Bash(yarn install --frozen-lockfile *)',
  // Python and Node on inline code or on stdin, a heredoc's included: no more
  // than a test script could run, or the run's Edit tool could write as a
  // script. The hard denies read the code for a push.
  ...['python', 'python3', 'py'].flatMap((python) => [`Bash(${python} -c *)`, `Bash(${python} - *)`]),
  ...['-e', '--eval', '-p', '--print', '-'].map((option) => `Bash(node ${option} *)`),
  // Common read-only shell commands, none with an option that writes.
  ...['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'echo', 'pwd', 'which', 'diff', 'file', 'stat', 'du', 'df'].map(
    (command) => `Bash(${command} *)`,
  ),
];

// The factory's commands: the rest of its allow list, which its own matcher
// lets through by reading the command, where no rule's glob can say it.
// Claude Code asks about these, and the gate answers them. Besides these,
// `cd` within the worktree and redirects to its files outside `.git` are
// covered, for the run's Edit tool writes there anyway (see `covers`).
function factoryCommand({ words, heredoc }: SimpleCommand, at: Place): boolean {
  const [program = '', ...args] = words;
  if (program === 'git' && args[0] === 'config') return readsGitConfig(args.slice(1));
  if (program === 'npx') return runsInstalled(args, at);
  if (program === 'sed') return editsWithin(args, at);
  if (Object.hasOwn(INTERPRETERS, program)) return runsCode(INTERPRETERS[program]!, args, heredoc, at);
  return false;
}

// `sed`, which reads like `cat`, or edits in place files in the worktree,
// as the run's Edit tool would. Its script isn't read: one that writes
// elsewhere with `w` is the kind of malice L1 doesn't guard against.
function editsWithin(args: string[], at: Place): boolean {
  let inPlace = false;
  let scripted = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith('--')) {
      inPlace ||= arg.startsWith('--in-place');
      scripted ||= /^--(expression|file)(=|$)/.test(arg);
      if (['--expression', '--file', '--line-length'].includes(arg)) i++;
    } else if (arg.startsWith('-') && arg !== '-') {
      // Short options cluster: `i` takes the rest as its suffix, and `e`,
      // `f` and `l` the rest or the next word as their value.
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!;
        if (flag === 'i') {
          inPlace = true;
          break;
        }
        if ('efl'.includes(flag)) {
          scripted ||= flag !== 'l';
          if (j === arg.length - 1) i++;
          break;
        }
      }
    } else operands.push(arg);
  }
  const files = scripted ? operands : operands.slice(1);
  return !inPlace || (files.length > 0 && files.every((file) => at.inside(file) !== null));
}

// Python and Node, by the options that run inline code and those harmless
// before a script.
const INTERPRETERS: Record<string, { inline: string[]; harmless: RegExp }> = {
  python: { inline: ['-c'], harmless: /^-[uBIEsSqOv]+$/ },
  python3: { inline: ['-c'], harmless: /^-[uBIEsSqOv]+$/ },
  py: { inline: ['-c'], harmless: /^-[uBIEsSqOv]+$/ },
  node: { inline: ['-e', '--eval', '-p', '--print'], harmless: /^--(no-warnings|enable-source-maps|experimental-strip-types)$/ },
};

// An interpreter on a script in the worktree, on inline code, or on a
// heredoc or stdin: what a test script would run, and what the run's Edit
// tool could write anyway. The hard denies read its code for a push.
function runsCode({ inline, harmless }: (typeof INTERPRETERS)[string], args: string[], heredoc: boolean, at: Place): boolean {
  let i = 0;
  while (i < args.length && harmless.test(args[i]!)) i++;
  const first = args[i];
  if (first === undefined) return heredoc;
  if (inline.includes(first)) return args[i + 1] !== undefined;
  return first === '-' || (!first.startsWith('-') && at.inside(first) !== null);
}

// `npx` of a binary the project installed, which runs what `npm run` would.
// Unless told `--no`, npx downloads a binary it can't find, so a binary not
// in `node_modules/.bin` yet, or one npx is told to fetch, still asks.
function runsInstalled(args: string[], at: Place): boolean {
  const bin = args.find((arg) => !['--no', '--no-install', '--offline', '--quiet', '-q'].includes(arg));
  return bin !== undefined && !bin.startsWith('-') && at.installed(bin);
}

// Reads of git config: a key alone, `get`, `list` or a read option, never a
// write. The run's global config is its own, and reading it changes nothing.
function readsGitConfig(args: string[]): boolean {
  if (args.some((arg) => CONFIG_WRITES.has(arg))) return false;
  if (['get', 'list'].includes(args[0] ?? '') || args.some((arg) => CONFIG_READS.has(arg))) return true;
  const keys: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (CONFIG_VALUED.has(args[i]!)) i++;
    else if (!args[i]!.startsWith('-')) keys.push(args[i]!);
  }
  return keys.length === 1 && !['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(keys[0]!);
}

const CONFIG_WRITES = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--get-color', '--get-colorbool']);
const CONFIG_VALUED = new Set(['-f', '--file', '--blob', '--type', '--default']);

// The rules an L1 call is allowed by without asking, besides its task's own:
// the factory's allow list and the operator's permissions file at `path`, as
// the file reads now. `error` says why the file grants nothing, when it doesn't.
export function readAllowRules(path: string): { rules: string[]; error: string | null } {
  const operator = readOperatorRules(path);
  return { rules: [...FACTORY_ALLOW_LIST, ...operator.rules], error: operator.error };
}

// The operator's own allow rules, from their permissions file:
//
//   allow:
//     - Bash(make *)
//
// No file grants nothing. `error` says why a file that can't be read or
// doesn't hold a list of rules grants nothing either.
function readOperatorRules(path: string): { rules: string[]; error: string | null } {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [], error: null };
    return { rules: [], error: `${path} couldn’t be read: ${(error as Error).message}` };
  }
  const allow = (raw as { allow?: unknown } | null)?.allow ?? [];
  if (!Array.isArray(allow) || !allow.every((rule) => typeof rule === 'string' && parseRule(rule))) {
    return { rules: [], error: `${path} must hold \`allow:\`, a list of rules such as \`Bash(make *)\`.` };
  }
  return { rules: allow, error: null };
}

// Whether any of the rules covers the call, made in the run's `worktree`. A
// Bash command chained with `&&`, `||`, `;`, `&` or `|` is covered when every
// part of it is, by a rule or as one of the factory's commands, each part
// redirecting only to files in the worktree, and each `cd` staying in it.
export function covers(rules: readonly string[], call: Pick<ToolCall, 'tool' | 'input'>, worktree: string | null): boolean {
  const parsed = rules.flatMap((rule) => parseRule(rule) ?? []).filter((rule) => toolMatches(rule.tool, call.tool));
  if (parsed.some((rule) => rule.specifier === null)) return true;
  if (call.tool === 'Bash') {
    const commands = readCommandLine(String(call.input.command ?? ''));
    if (commands === null || commands.length === 0) return false;
    // Where each command runs, as far as the `cd`s before it in the line say.
    let dir = worktree === null ? null : slashed(worktree);
    return commands.every((command) => {
      const at = place(worktree, dir);
      if (!command.writes.every((path) => at.inside(path) !== null)) return false;
      if (command.words[0] === 'cd') {
        dir = command.words.length === 2 ? at.inside(command.words[1]!) : null;
        return dir !== null;
      }
      return parsed.some((rule) => bashMatches(rule.specifier!, command.text)) || factoryCommand(command, at);
    });
  }
  if (call.tool === 'WebFetch') {
    const host = hostOf(call.input.url);
    return host !== null && parsed.some((rule) => rule.specifier!.startsWith('domain:') && glob(rule.specifier!.slice(7)).test(host));
  }
  const target = targetOf(call.input);
  return target !== null && parsed.some((rule) => glob(slashed(rule.specifier!)).test(posix.normalize(slashed(target))));
}

// The call's own rule, for Allow for this task and Allow once: its exact
// command, its URL's domain, or its path. Those rules hold for calls with the
// same rule, never as patterns, so a `*` in a command stays a `*`.
export function ruleFor({ tool, input }: Pick<ToolCall, 'tool' | 'input'>): string {
  if (tool === 'Bash' && typeof input.command === 'string') return `Bash(${input.command.trim()})`;
  if (tool === 'WebFetch') {
    const host = hostOf(input.url);
    return host ? `WebFetch(domain:${host})` : tool;
  }
  const target = targetOf(input);
  return target ? `${tool}(${target})` : tool;
}

type Rule = { tool: string; specifier: string | null };

function parseRule(rule: string): Rule | null {
  const match = /^([^()\s]+)(?:\((.*)\))?$/s.exec(rule.trim());
  return match ? { tool: match[1]!, specifier: match[2]?.trim() || null } : null;
}

// `mcp__server` and `mcp__server__*` stand for every tool of the server.
function toolMatches(rule: string, tool: string): boolean {
  if (rule === tool) return true;
  const server = rule.replace(/__\*$/, '');
  return server.startsWith('mcp__') && server.split('__').length === 2 && tool.startsWith(`${server}__`);
}

// A Bash specifier: a glob over the command, where a trailing ` *` also
// matches the bare command, and the legacy `prefix:*` means the same.
function bashMatches(specifier: string, command: string): boolean {
  const pattern = specifier.replace(/:\*$/, ' *');
  if (pattern.endsWith(' *') && command === pattern.slice(0, -2)) return true;
  return glob(pattern).test(command);
}

// `*` matches anything, everything else itself.
function glob(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's');
}

function hostOf(url: unknown): string | null {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
}

// What a tool other than Bash and WebFetch is pointed at, for its specifier.
function targetOf(input: Record<string, unknown>): string | null {
  const target = ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query'].map((name) => input[name]).find((value) => typeof value === 'string');
  return (target as string | undefined) ?? null;
}

const slashed = (path: string) => path.replaceAll('\\', '/');

// Where a command runs: in `dir`, within the run's worktree. Paths resolve
// from `dir`, as if the call started at the top of the worktree.
type Place = {
  // The path, resolved, when it lies in the worktree outside `.git`, which
  // holds the config and hooks the run must leave alone; null otherwise, or
  // when it names a variable or home, which no reading can resolve.
  inside(path: string): string | null;
  // Whether the project installed `bin`, in `dir` or a folder above it in the worktree.
  installed(bin: string): boolean;
};

function place(worktree: string | null, dir: string | null): Place {
  const top = worktree === null ? null : comparable(posix.normalize(slashed(worktree)).replace(/\/$/, ''));
  return {
    installed(bin) {
      if (top === null || dir === null || !/^[\w.-]+$/.test(bin)) return false;
      for (let at = dir; comparable(at).startsWith(top); at = posix.dirname(at)) {
        if (existsSync(posix.join(at, 'node_modules', '.bin', bin))) return true;
        if (comparable(at) === top) break;
      }
      return false;
    },
    inside(path) {
      if (top === null || dir === null || path === '' || /[$~]/.test(path)) return null;
      // Git Bash names `D:\` as `/d/`.
      const written = slashed(path).replace(/^\/([a-z])(?=\/|$)/i, (_, drive: string) => `${drive}:`);
      const resolved = posix.normalize(/^([a-z]:)?\//i.test(written) ? written : posix.join(dir, written)).replace(/\/$/, '');
      const relative = comparable(resolved);
      if (relative !== top && !relative.startsWith(`${top}/`)) return null;
      return relative.slice(top.length).split('/').includes('.git') ? null : resolved;
    },
  };
}

// Windows paths compare whatever their case.
const comparable = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
