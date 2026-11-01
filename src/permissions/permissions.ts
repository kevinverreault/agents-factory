// The L1 gate's rules (ADR 0007): which tool calls an AFK run may make
// without asking the operator. They come from the factory's own allow list,
// the operator's permissions file and the task, never from the target repo.
// Rules use Claude Code's syntax: `Tool`, or `Tool(specifier)`. Bash rules
// are best-effort, not a security boundary: L1 guards against accidents.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { Document, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { readCommandLine, type SimpleCommand } from './shell.ts';

// A tool call Claude Code asked about. `summary` is what it is pointed at, on one line.
export type ToolCall = { id: string; tool: string; input: Record<string, unknown>; summary: string };

// The options that read git config and never write it.
const CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--get-color', '--get-colorbool'];

// Python and Node, by the options that run inline code and those harmless
// before a script. The hard denies read the inline code for a push.
const PYTHON = { inline: ['-c'], harmless: /^-[uBIEsSqOv]+$/ };
export const INTERPRETERS: Readonly<Record<string, { inline: string[]; harmless: RegExp }>> = {
  python: PYTHON,
  python3: PYTHON,
  py: PYTHON,
  node: { inline: ['-e', '--eval', '-p', '--print'], harmless: /^--(no-warnings|enable-source-maps|experimental-strip-types)$/ },
};

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
  ...[...CONFIG_READS, 'get', 'list'].map((read) => `Bash(git config ${read} *)`),
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
  'Bash(pnpm i --frozen-lockfile *)',
  'Bash(yarn install --immutable *)',
  'Bash(yarn install --frozen-lockfile *)',
  // Python and Node on inline code or on stdin, a heredoc's included: no more
  // than a test script could run, or the run's Edit tool could write as a
  // script. The hard denies read the code, inline or in a heredoc, for a push.
  ...Object.entries(INTERPRETERS).flatMap(([name, { inline }]) => [...inline, '-'].map((option) => `Bash(${name} ${option} *)`)),
  // Common read-only shell commands, none with an option that writes.
  ...['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'echo', 'pwd', 'which', 'diff', 'file', 'stat', 'du', 'df'].map(
    (command) => `Bash(${command} *)`,
  ),
];

// The factory's commands: the rest of its allow list, which its own matcher
// lets through by reading the command, where no rule's glob can say it.
// Claude Code asks about these, and the gate answers them. Besides these,
// `cd` within the worktree and redirects to its files outside `.git` are
// covered, for the run's Edit tool writes there anyway (see `uncovered`).
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

// An interpreter on a script in the worktree, on inline code, or on a
// heredoc or stdin: what a test script would run, and what the run's Edit
// tool could write anyway. The hard denies read inline code and heredocs
// for a push, but not scripts: the cleaned environment stops their pushes.
function runsCode({ inline, harmless }: (typeof INTERPRETERS)[string], args: string[], heredoc: string | null, at: Place): boolean {
  let i = 0;
  while (i < args.length && harmless.test(args[i]!)) i++;
  const first = args[i];
  if (first === undefined) return heredoc !== null;
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
  if (['get', 'list'].includes(args[0] ?? '') || args.some((arg) => CONFIG_READS.includes(arg))) return true;
  const keys: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (CONFIG_VALUED.has(args[i]!)) i++;
    else if (!args[i]!.startsWith('-')) keys.push(args[i]!);
  }
  return keys.length === 1 && !['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(keys[0]!);
}

const CONFIG_WRITES = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit']);
const CONFIG_VALUED = new Set(['-f', '--file', '--blob', '--type', '--default']);

// The rules an L1 call is allowed by without asking, besides its task's own:
// the factory's allow list and the operator's permissions file at `path`, as
// the file reads now. `error` says why the file grants nothing, when it doesn't.
export function readAllowRules(path: string): { rules: string[]; error: string | null } {
  const operator = readOperatorFile(path);
  return { rules: [...FACTORY_ALLOW_LIST, ...operator.rules], error: operator.error };
}

// Adds the rules to the operator's permissions file for Allow always,
// creating it if missing and keeping its rules and comments. A rule already
// in it isn't added again. Why nothing was added, if the file can't be read,
// doesn't hold a list of rules, or can't be written.
export function addOperatorRules(path: string, rules: readonly string[]): string | null {
  const { document = new Document(), rules: present, error } = readOperatorFile(path);
  if (error) return error;
  if (document.contents !== null && !isMap(document.contents)) return mustHoldRules(path);
  const held = present.map((rule) => rule.trim());
  const added = [...new Set(rules.map((rule) => rule.trim()))].filter((rule) => !held.includes(rule));
  if (added.length === 0) return null;
  const allow = document.get('allow', true);
  // A list named elsewhere (`allow: *mine`) would lose its rules if replaced.
  if (!isSeq(allow) && allow !== undefined && !(isScalar(allow) && allow.value === null)) {
    return `${path} names its \`allow:\` list elsewhere, so the factory can’t add to it: add the rules there by hand.`;
  }
  if (isSeq(allow)) for (const rule of added) allow.add(rule);
  else {
    // An empty `allow:` keeps its comment.
    const list = document.createNode(added);
    list.comment = allow?.comment;
    document.set('allow', list);
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, document.toString());
  } catch (error) {
    return `${path} couldn’t be written: ${(error as Error).message}`;
  }
  return null;
}

// The operator's permissions file, unless it is missing, with its own allow
// rules:
//
//   allow:
//     - Bash(make *)
//
// No file grants nothing. `error` says why a file that can't be read or
// doesn't hold a list of rules grants nothing either.
function readOperatorFile(path: string): { document?: Document; rules: string[]; error: string | null } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [], error: null };
    return { rules: [], error: `${path} couldn’t be read: ${(error as Error).message}` };
  }
  const document = parseDocument(text);
  const [problem] = document.errors;
  if (problem) return { rules: [], error: `${path} couldn’t be read: ${problem.message}` };
  const allow = (document.toJS() as { allow?: unknown } | null)?.allow ?? [];
  if (!Array.isArray(allow) || !allow.every(isRule)) return { rules: [], error: mustHoldRules(path) };
  return { document, rules: allow, error: null };
}

const mustHoldRules = (path: string) => `${path} must hold \`allow:\`, a list of rules such as \`Bash(make *)\`.`;

// The parts of the call no rule covers, each a call of its own, made in the
// run's `worktree` when known: the commands of a Bash chain (`&&`, `||`, `;`,
// `&` or `|`), less their redirections, which a rule or the factory's
// commands may cover, or else the call itself. A Bash command that can't be
// read, writes outside the worktree or `cd`s out of it is one part, which
// only its exact rule covers. None when the rules cover the call.
export function uncovered(rules: readonly string[], call: ToolCall, worktree: string | null = null): ToolCall[] {
  const parsed = rules.flatMap((rule) => parseRule(rule) ?? []).filter((rule) => toolMatches(rule.tool, call.tool));
  if (parsed.some((rule) => rule.specifier === null)) return [];
  if (call.tool === 'Bash') {
    const command = String(call.input.command ?? '');
    const commands = readCommandLine(command);
    const parts = partsWithin(commands, worktree);
    if (parts === null) return parsed.some((rule) => rule.specifier === command.trim()) ? [] : [call];
    const left = parts.filter((part) => !parsed.some((rule) => bashMatches(rule.specifier!, part.command.text)) && !factoryCommand(part.command, part.at));
    return left.map(({ command: { text } }) => (commands!.length === 1 ? call : { ...call, input: { ...call.input, command: text }, summary: text }));
  }
  if (call.tool === 'WebFetch') {
    const host = hostOf(call.input.url);
    return host !== null && parsed.some((rule) => rule.specifier!.startsWith('domain:') && glob(rule.specifier!.slice(7)).test(host)) ? [] : [call];
  }
  const target = targetOf(call.input);
  return target !== null && parsed.some((rule) => glob(slashed(rule.specifier!)).test(posix.normalize(slashed(target)))) ? [] : [call];
}

// The simple commands of a line, but its `cd`s, each with where it runs, or
// null when the line can't be read, writes outside the worktree, or a `cd`
// may leave it.
function partsWithin(commands: SimpleCommand[] | null, worktree: string | null): { command: SimpleCommand; at: Place }[] | null {
  if (commands === null || commands.length === 0) return null;
  // Where each command runs, as far as the `cd`s before it in the line say.
  let dir = worktree === null ? null : slashed(worktree);
  const parts: { command: SimpleCommand; at: Place }[] = [];
  for (const command of commands) {
    const at = place(worktree, dir);
    if (!command.writes.every((path) => at.inside(path) !== null)) return null;
    if (command.words[0] !== 'cd') parts.push({ command, at });
    else if ((dir = movesTo(command, at)) === null) return null;
  }
  return parts;
}

// Where a `cd` leaves the commands after it: a folder in the worktree, or
// null when it may leave them anywhere else. Its effect must reach them, so
// a `cd` in the background or a pipe, or before `||`, is never covered, and
// before `;` its folder must exist, or they would run where the line started.
function movesTo({ words, then }: SimpleCommand, at: Place): string | null {
  const [, folder, ...rest] = words;
  if (folder === undefined || folder.startsWith('-') || rest.length || !['&&', ';', null].includes(then)) return null;
  const to = at.inside(folder);
  return to !== null && (then !== ';' || statSync(to, { throwIfNoEntry: false })?.isDirectory()) ? to : null;
}

// The rule Allow for this task and Allow always propose for a part no rule
// covers: a Bash command's program and its subcommand or leading option,
// with any arguments (`Bash(npm install *)`, `Bash(sed -i *)`). An interpreter's
// pattern names the script it runs (`Bash(node scripts/seed.js *)`), and
// inline code gets its exact command, as does a command that can't be
// split, redirects or takes a heredoc, and a call to any other tool its own rule.
export function patternFor(part: Pick<ToolCall, 'tool' | 'input'>): string {
  const commands = part.tool === 'Bash' ? readCommandLine(String(part.input.command ?? '')) : null;
  if (commands?.length !== 1 || commands[0]!.writes.length > 0 || commands[0]!.heredoc !== null) return ruleFor(part);
  const { text, words: [program = '', next] } = commands[0]!;
  if (SCRIPT_RUNNERS.has(program) && next !== undefined) {
    if (INLINE_CODE.test(next)) return `Bash(${text})`;
    if (!next.startsWith('-')) return `Bash(${program} ${next} *)`;
  }
  const words = next !== undefined && /^-{0,2}[A-Za-z][\w-]*$/.test(next) ? [program, next] : [program];
  return `Bash(${words.join(' ')} *)`;
}

// Programs that run a script or inline code they are given, and the options
// that give them inline code.
const SCRIPT_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd', 'node', 'deno', 'python', 'python3', 'ruby', 'perl']);
const INLINE_CODE = /^(?:-c|-e|--eval|-command|\/c)$/i;

// Whether the text is a rule: `Tool`, or `Tool(specifier)`.
export function isRule(rule: unknown): rule is string {
  return typeof rule === 'string' && parseRule(rule) !== null;
}

// The call's own rule, for Allow once: its exact command, its URL's domain,
// or its path.
export function ruleFor({ tool, input }: Pick<ToolCall, 'tool' | 'input'>): string {
  if (tool === 'Bash' && typeof input.command === 'string') return `Bash(${input.command.trim()})`;
  if (tool === 'WebFetch') {
    const host = hostOf(input.url);
    return host ? `WebFetch(domain:${host})` : tool;
  }
  const target = targetOf(input);
  return target ? `${tool}(${target})` : tool;
}

// A call whose own rule this is, as `ruleFor` makes one, which rules cover
// just as they cover that call: a rule tells calls apart only by what it names.
export function callWithRule(rule: string): Pick<ToolCall, 'tool' | 'input'> {
  const { tool, specifier } = parseRule(rule) ?? { tool: rule, specifier: null };
  if (specifier === null) return { tool, input: {} };
  if (tool === 'Bash') return { tool, input: { command: specifier } };
  if (tool === 'WebFetch') return { tool, input: { url: `https://${specifier.replace(/^domain:/, '')}/` } };
  return { tool, input: { file_path: specifier } };
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
      for (let folder = dir; comparable(folder).startsWith(top); folder = posix.dirname(folder)) {
        if (existsSync(posix.join(folder, 'node_modules', '.bin', bin))) return true;
        if (comparable(folder) === top) break;
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
