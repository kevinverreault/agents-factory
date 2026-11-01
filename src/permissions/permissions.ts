// The L1 gate's rules (ADR 0007): which tool calls an AFK run may make
// without asking the operator. They come from the factory's own allow list,
// the operator's permissions file and the task, never from the target repo.
// Rules use Claude Code's syntax: `Tool`, or `Tool(specifier)`. Bash rules
// are best-effort, not a security boundary: L1 guards against accidents.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, posix } from 'node:path';
import { Document, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { readCommandLine, type SimpleCommand } from './shell.ts';

// A tool call Claude Code asked about. `summary` is what it is pointed at, on one line.
export type ToolCall = { id: string; tool: string; input: Record<string, unknown>; summary: string };

// The options that read git config and never write it.
const CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--get-color', '--get-colorbool'];

// Python, Node and Perl, by the options that run inline code, those harmless
// before a script, and Perl's that end in one of them (`-pe`) or edit the
// files after the code in place (`-pi`). The hard denies read the inline
// code for a push.
type Interpreter = { inline: string[]; harmless: RegExp; clustered?: RegExp; inPlace?: RegExp };
const PYTHON: Interpreter = { inline: ['-c'], harmless: /^-[uBIEsSqOv]+$/ };
export const INTERPRETERS: Readonly<Record<string, Interpreter>> = {
  python: PYTHON,
  python3: PYTHON,
  py: PYTHON,
  node: { inline: ['-e', '--eval', '-p', '--print'], harmless: /^--(no-warnings|enable-source-maps|experimental-strip-types)$/ },
  perl: { inline: ['-e', '-E'], harmless: /^-(?!$)(?:[nplaw]|0[0-7]*)*(?:i[\w.~-]*)?$/, clustered: /^-(?:[nplaw]|0[0-7]*)+[eE]$/, inPlace: /^-(?:[nplaw]|0[0-7]*)*i/ },
};

// Whether the word gives the interpreter inline code, as the next word.
export const givesCode = ({ inline, clustered }: Interpreter, word: string) => inline.includes(word) || (clustered?.test(word) ?? false);

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
  ...[
    'status',
    'diff',
    'log',
    'show',
    'blame',
    'ls-files',
    'rev-parse',
    'grep',
    'add',
    'commit',
    'merge-base',
    'rev-list',
    'cat-file',
    'ls-tree',
    'describe',
    'shortlog',
    'for-each-ref',
    'show-ref',
    'name-rev',
    'stash list',
    'stash show',
  ].map((verb) => `Bash(git ${verb} *)`),
  'Bash(git branch --show-current)',
  'Bash(git --version)',
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
  // Perl takes `-i` after its code too, so the gate reads it instead, for
  // the files it edits in place.
  ...Object.entries(INTERPRETERS).flatMap(([name, { inline, inPlace }]) =>
    inPlace ? [] : [...inline, '-'].map((option) => `Bash(${name} ${option} *)`),
  ),
  // Common read-only shell commands, none with an option that writes.
  ...[
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'grep',
    'rg',
    'echo',
    'printf',
    'pwd',
    'which',
    'diff',
    'cmp',
    'comm',
    'file',
    'stat',
    'du',
    'df',
    'od',
    'cut',
    'tr',
    'nl',
    'paste',
    'column',
    'basename',
    'dirname',
    'realpath',
    'test',
    'true',
  ].map((command) => `Bash(${command} *)`),
];

// The factory's commands: the rest of its allow list, which its own matcher
// lets through by reading the command, where no rule's glob can say it.
// Claude Code asks about these, and the gate answers them. Besides these,
// `cd` within the worktree and redirects to its files outside `.git` are
// covered, for the run's Edit tool writes there anyway (see `uncovered`).
// `covered` says whether the rules or these cover another command.
function factoryCommand(command: SimpleCommand, at: Place, covered: (other: SimpleCommand) => boolean): boolean {
  const { words, heredoc } = command;
  const [program = '', ...args] = words;
  if (program === 'git' && args[0] === '-c') return withPlainConfig(command, covered);
  if (program === 'git' && args[0] === 'config') return readsGitConfig(args.slice(1));
  if (program === 'git' && args[0] === 'branch') return listsBranches(args.slice(1));
  if (program === 'gh' && args[0] === 'api') return readsApi(args.slice(1));
  if (program === 'npx') return runsInstalled(args, at);
  if (program === 'sed') return editsWithin(args, at);
  if (program === 'sort') return sortsWithin(args, at);
  if (program === 'uniq') return dedupesWithin(args, at);
  if (program === 'find') return findsOnly(args);
  if (Object.hasOwn(INTERPRETERS, program)) return runsCode(INTERPRETERS[program]!, args, heredoc, at);
  return false;
}

// `git -c name=value`, for settings that change how git shows what it reads
// or treats line endings, and nothing it runs: covered when the git command
// without them is. Others, such as `core.hooksPath` or `core.pager`, run programs.
function withPlainConfig(command: SimpleCommand, covered: (other: SimpleCommand) => boolean): boolean {
  const [, ...args] = command.words;
  let i = 0;
  for (; args[i] === '-c'; i += 2) if (!PLAIN_CONFIG.test(args[i + 1] ?? '')) return false;
  const words = ['git', ...args.slice(i)];
  return covered({ ...command, text: words.map(quoted).join(' '), words });
}

// The settings `withPlainConfig` lets through.
const PLAIN_CONFIG = /^(core\.(autocrlf|safecrlf|eol|quotepath|filemode|ignorecase|longpaths)|color\.[\w.-]+|advice\.\w+|i18n\.\w+|user\.(name|email))(=|$)/i;

// A word as the shell would read it back.
const quoted = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

// `git branch` listing branches: no name, or patterns after `--list`, and
// no option that creates, deletes, moves or sets upstreams.
function listsBranches(args: string[]): boolean {
  let listing = false;
  let names = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (BRANCH_FILTERS.has(arg)) i++;
    else if (/^--(contains|no-contains|merged|no-merged|points-at|sort|format|color|column|abbrev)=/.test(arg)) continue;
    else if (/^-[arvli]+$/.test(arg) || BRANCH_READS.has(arg)) listing ||= /^-[arvi]*l/.test(arg) || arg === '--list';
    else if (arg.startsWith('-')) return false;
    else names++;
  }
  return names === 0 || listing;
}

// The options of `git branch` that pick which branches it lists, by a value,
// and those that only list.
const BRANCH_FILTERS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);
const BRANCH_READS = new Set(['--all', '--remotes', '--verbose', '--list', '--show-current', '--ignore-case', '--no-color', '--no-column', '--omit-empty']);

// `sort`, whose output goes to the standard output, or to a file in the
// worktree. `--compress-program` runs a program of its choosing.
function sortsWithin(args: string[], at: Place): boolean {
  const { options } = optionsOf(args, 'oktST', [
    '--output',
    '--compress-program',
    '--key',
    '--field-separator',
    '--buffer-size',
    '--temporary-directory',
    '--parallel',
    '--batch-size',
    '--files0-from',
    '--random-source',
    '--sort',
  ]);
  if (options.some(({ name }) => name === '--compress-program')) return false;
  return options.every(({ name, value }) => !['-o', '--output'].includes(name) || (value !== null && at.inside(value) !== null));
}

// `uniq`, whose second file, if any, is the one it writes.
function dedupesWithin(args: string[], at: Place): boolean {
  const { operands } = optionsOf(args, 'fsw', ['--skip-fields', '--skip-chars', '--check-chars']);
  return operands.length < 2 || (operands.length === 2 && at.inside(operands[1]!) !== null);
}

// `find` that only finds, with none of the actions by which it deletes,
// runs a command or writes a file.
function findsOnly(args: string[]): boolean {
  return !args.some((arg) => FIND_ACTIONS.has(arg));
}

const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);

// An option a command was given, by its name in full, with its value if it takes one.
type Option = { name: string; value: string | null };

// A command's options and its operands, as getopt reads them: a short option
// in `valued` takes the rest of its cluster or the next word, and a long one
// in `longValued`, or the one that its unique prefix names, its `=value` or
// the next word.
function optionsOf(args: string[], valued: string, longValued: string[]): { options: Option[]; operands: string[] } {
  const options: Option[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const written = equals < 0 ? arg : arg.slice(0, equals);
      const named = longValued.filter((option) => option.startsWith(written));
      const name = named.length === 1 ? named[0]! : written;
      const value = equals >= 0 ? arg.slice(equals + 1) : longValued.includes(name) ? (args[++i] ?? null) : null;
      options.push({ name, value });
    } else if (arg.startsWith('-') && arg !== '-') {
      for (let j = 1; j < arg.length; j++) {
        if (!valued.includes(arg[j]!)) {
          options.push({ name: `-${arg[j]}`, value: null });
          continue;
        }
        options.push({ name: `-${arg[j]}`, value: j < arg.length - 1 ? arg.slice(j + 1) : (args[++i] ?? null) });
        break;
      }
    } else operands.push(arg);
  }
  return { options, operands };
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

// An interpreter on a script in the worktree, on inline code, on a heredoc
// or stdin, or on a script the line wrote from a heredoc: what a test script
// would run, and what the run's Edit tool could write anyway. The hard
// denies read inline code and heredocs for a push, but not scripts in the
// worktree: the cleaned environment stops their pushes. Files it edits in
// place lie in the worktree, as sed's must.
function runsCode(interpreter: Interpreter, args: string[], heredoc: string | null, at: Place): boolean {
  const { harmless, inPlace } = interpreter;
  let i = 0;
  while (i < args.length && harmless.test(args[i]!)) i++;
  const first = args[i];
  if (first === undefined) return heredoc !== null;
  const edits = inPlace !== undefined && args.some((arg) => inPlace.test(arg));
  if (givesCode(interpreter, first)) {
    if (args[i + 1] === undefined) return false;
    if (!edits) return true;
    // The files after the code, past more code and harmless options.
    for (let j = i + 2; j < args.length; j++) {
      const arg = args[j]!;
      if (givesCode(interpreter, arg)) j++;
      else if (arg.startsWith('-') ? !harmless.test(arg) : at.inside(arg) === null) return false;
    }
    return true;
  }
  if (first !== '-' && (first.startsWith('-') || (at.inside(first) === null && !at.wrote(first)))) return false;
  return !edits || args.slice(i + 1).every((arg) => arg.startsWith('-') || at.inside(arg) !== null);
}

// `gh api` reading: GET, as it is unless told a method or given fields or
// a body to send. A GraphQL query is sent as a POST, mutation or not.
function readsApi(args: string[]): boolean {
  const { options, operands } = optionsOf(args, 'XHfFpqt', ['--method', '--header', '--raw-field', '--field', '--preview', '--jq', '--template', '--input', '--hostname', '--cache']);
  const method = options.filter(({ name }) => name === '-X' || name === '--method').at(-1)?.value?.toUpperCase();
  const sends = options.some(({ name }) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(name));
  return operands[0] !== 'graphql' && (method === undefined ? !sends : method === 'GET');
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
    const covered = (simple: SimpleCommand, at: Place): boolean =>
      parsed.some((rule) => bashMatches(rule.specifier!, simple.text)) || factoryCommand(simple, at, (other) => covered(other, at));
    const left = parts.filter((part) => !covered(part.command, part.at));
    // A loop's command, run once for each of its words, is one part.
    const texts = [...new Set(left.map(({ command: { text } }) => text))];
    return texts.map((text) => (commands!.length === 1 ? call : { ...call, input: { ...call.input, command: text }, summary: text }));
  }
  if (call.tool === 'WebFetch') {
    const host = hostOf(call.input.url);
    return host !== null && parsed.some((rule) => rule.specifier!.startsWith('domain:') && glob(rule.specifier!.slice(7)).test(host)) ? [] : [call];
  }
  const target = targetOf(call.input);
  return target !== null && parsed.some((rule) => glob(slashed(rule.specifier!)).test(posix.normalize(slashed(target)))) ? [] : [call];
}

// The simple commands of a line, but its `cd`s and bare redirections, each
// with where it runs, or null when the line can't be read, writes outside
// the worktree, or a `cd` may leave it. A `cd` in a loop, a condition or a
// group may run more than once or not at all, so no reading says where it
// leaves. A heredoc `cat` writes to the temp folder is a script the
// commands after it may run, as an interpreter would run the heredoc itself.
function partsWithin(commands: SimpleCommand[] | null, worktree: string | null): { command: SimpleCommand; at: Place }[] | null {
  if (commands === null || commands.length === 0) return null;
  // Where each command runs, as far as the `cd`s before it in the line say.
  let dir = worktree === null ? null : slashed(worktree);
  const scripts = new Set<string>();
  const parts: { command: SimpleCommand; at: Place }[] = [];
  for (const command of commands) {
    const at = place(worktree, dir, new Set(scripts));
    const [script] = command.writes;
    if (writesScript(command) && inTemp(script!) !== null) scripts.add(inTemp(script!)!);
    else if (!command.writes.every((path) => at.inside(path) !== null)) return null;
    if (command.words[0] === 'cd') {
      if (command.compound || (dir = movesTo(command, at)) === null) return null;
    } else if (command.words.length) parts.push({ command, at });
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

// A path with forward slashes, and with a drive Git Bash names `/d/` as `D:\` is.
const fromBash = (path: string) => slashed(path).replace(/^\/([a-z])(?=\/|$)/i, (_, drive: string) => `${drive}:`);

// Where a command runs: in `dir`, within the run's worktree. Paths resolve
// from `dir`, as if the call started at the top of the worktree.
type Place = {
  // The path, resolved, when it lies in the worktree outside `.git`, which
  // holds the config and hooks the run must leave alone; null otherwise, or
  // when it names a variable or home, which no reading can resolve.
  inside(path: string): string | null;
  // Whether the project installed `bin`, in `dir` or a folder above it in the worktree.
  installed(bin: string): boolean;
  // Whether the line wrote the script at `path` from a heredoc before this command.
  wrote(path: string): boolean;
};

// The temp folder, as Git Bash names it and as the OS does.
const TEMP_FOLDERS = ['/tmp', posix.normalize(slashed(tmpdir())).replace(/\/$/, '')];

// The path, resolved, when it is absolute and lies in the temp folder.
export function inTemp(path: string): string | null {
  if (/[$~]/.test(path)) return null;
  const resolved = posix.normalize(fromBash(path));
  return TEMP_FOLDERS.some((folder) => comparable(resolved).startsWith(`${comparable(folder)}/`)) ? resolved : null;
}

// Whether the command is a `cat` writing a heredoc to one file, which then
// holds just the heredoc, wherever the line goes: not appending, and not in
// a loop, a condition or a group that may not run it.
export const writesScript = ({ words, writes, appends, heredoc, compound }: SimpleCommand) =>
  heredoc !== null && words.join(' ') === 'cat' && writes.length === 1 && appends.length === 0 && !compound;

function place(worktree: string | null, dir: string | null, scripts: ReadonlySet<string> = new Set()): Place {
  const top = worktree === null ? null : comparable(posix.normalize(slashed(worktree)).replace(/\/$/, ''));
  return {
    wrote(path) {
      const resolved = inTemp(path);
      return resolved !== null && scripts.has(resolved);
    },
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
      const written = fromBash(path);
      const resolved = posix.normalize(/^([a-z]:)?\//i.test(written) ? written : posix.join(dir, written)).replace(/\/$/, '');
      const relative = comparable(resolved);
      if (relative !== top && !relative.startsWith(`${top}/`)) return null;
      return relative.slice(top.length).split('/').includes('.git') ? null : resolved;
    },
  };
}

// Windows paths compare whatever their case.
const comparable = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
