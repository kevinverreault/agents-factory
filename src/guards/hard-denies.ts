// The hard denies (ADR 0007): what an AFK run's PreToolUse hook refuses at
// every level, whatever the gate would allow, with a message saying the
// factory pushes. They read a Bash command as a shell would split it, but
// they are best-effort: the cleaned environment makes a push that slips past
// fail in git itself, and the check after the run catches the rest.
import { execFile } from 'node:child_process';
import { givesCode, inTemp, INTERPRETERS, type ToolCall } from '../permissions/permissions.ts';
import { KEYWORDS, readCommandLine } from '../permissions/shell.ts';

// What a refusal needs to know of the run's worktree.
export type RunHistory = {
  // Whether `rev` names a commit there.
  isCommit(rev: string): Promise<boolean>;
  // Whether `rev` names a commit that is the run's starting commit or has it
  // in its history: moving the branch there rewrites nothing from before the run.
  keepsStart(rev: string): Promise<boolean>;
};

const REMOTE_CHANGES = new Set(['add', 'rm', 'remove', 'rename', 'set-url', 'set-branches', 'set-head', 'prune']);

// The same refusals as Claude Code deny rules, for the plainest spellings:
// they hold even if the hook isn't consulted. The hook answers first, and
// its refusal says why.
export const HARD_DENY_RULES: readonly string[] = [
  'Bash(git push *)',
  'Bash(git send-pack *)',
  'Bash(git worktree *)',
  'Bash(git switch *)',
  'Bash(git filter-branch *)',
  'Bash(git filter-repo *)',
  'Bash(git update-ref *)',
  'Bash(git replace *)',
  ...[...REMOTE_CHANGES].map((verb) => `Bash(git remote ${verb} *)`),
  'Bash(git config --global *)',
  'Bash(git config --system *)',
  'Bash(gh auth *)',
];

// Why the factory refuses the tool call, or null when the hook lets it through.
export async function refusal(call: Pick<ToolCall, 'tool' | 'input'>, history: RunHistory): Promise<string | null> {
  const what = SHELL_TOOLS.has(call.tool) ? await refusedIn(String(call.input.command ?? ''), history) : refusedTool(call);
  return what && `${what} is refused in an AFK run: the factory pushes for you, from the task branch as you leave it. Commit your work there and end the run.`;
}

// The real history of the run's worktree at `cwd`, which started at `start`.
export function runHistoryIn(cwd: string, start: string): RunHistory {
  // Git's exit status: 0 yes, 1 no, anything else when `rev` isn't a commit.
  const status = (...args: string[]) =>
    new Promise<number>((done) =>
      execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (error) => done(error ? Number(error.code ?? 128) : 0)),
    );
  return {
    async isCommit(rev) {
      return (await status('rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`)) === 0;
    },
    async keepsStart(rev) {
      return (await status('merge-base', '--is-ancestor', start, `${rev}^{commit}`)) === 0;
    },
  };
}

// Git invocations read alike in either shell, as far as the denies go.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// Claude Code's own worktrees, and edits in the git directory, which holds
// the config and hooks the run must leave alone.
function refusedTool({ tool, input }: Pick<ToolCall, 'tool' | 'input'>): string | null {
  if (tool === 'EnterWorktree') return 'Entering a worktree';
  if (!FILE_TOOLS.has(tool)) return null;
  const path = String(input.file_path ?? input.notebook_path ?? '').replaceAll('\\', '/');
  return /(^|\/)\.git(\/|$)/.test(path) ? 'Editing files under .git' : null;
}

// What the first refused part of the command does, or null, read as it is
// written and with the variables the line sets expanded, as the gate reads
// it. A command that runs Python, Node or Perl is read for the commands its
// code spells out too.
async function refusedIn(command: string, history: RunHistory): Promise<string | null> {
  const commands = [...simpleCommands(command), ...(readCommandLine(command) ?? []).map(({ words }) => words)];
  for (const words of commands) {
    const what = await refusedCommand(words, history);
    if (what) return what;
  }
  return commands.some((words) => isInterpreter(programOf(words).program)) ? refusedInInterpreters(command, history) : null;
}

// Prefixes that run the command after them.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'nice', 'xargs', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

const isInterpreter = (program: string) => Object.hasOwn(INTERPRETERS, program);

// What the first command spelled out in the code the line hands Python, Node
// or Perl, inline, in a heredoc, or in a script it wrote from a heredoc,
// does that is refused. A line the gate can't read, for it substitutes
// commands, is read whole.
async function refusedInInterpreters(command: string, history: RunHistory): Promise<string | null> {
  const commands = readCommandLine(command);
  if (commands === null) return refusedInCode(command, history);
  // Every heredoc the line writes to a file, by the file as the gate resolves it.
  const written = new Map<string, string[]>();
  const file = (path: string) => inTemp(path) ?? path;
  for (const { writes, heredoc } of commands) {
    for (const path of heredoc === null ? [] : writes) written.set(file(path), [...(written.get(file(path)) ?? []), heredoc!]);
  }
  for (const { words, heredoc } of commands) {
    const { program, args } = programOf(words);
    if (!isInterpreter(program)) continue;
    const inline = args.flatMap((arg, i) => (givesCode(INTERPRETERS[program]!, arg) ? [args[i + 1]] : []));
    for (const code of [...inline, heredoc, ...args.flatMap((arg) => written.get(file(arg)) ?? [])]) {
      const what = code ? await refusedInCode(code, history) : null;
      if (what) return what;
    }
  }
  return null;
}

// The program a simple command runs, past any keywords, assignments and
// wrappers before it, and the words after it.
function programOf(words: string[]): { program: string; args: string[] } {
  let i = 0;
  while (KEYWORDS.has(words[i] ?? '')) i++;
  // Assignments, wrappers and the wrappers' own options come first.
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]!) || WRAPPERS.has(programName(words[i]!)))) {
    i++;
    while (i < words.length && /^(-|\d+$)/.test(words[i]!)) i++;
  }
  return { program: words[i] === undefined ? '' : programName(words[i]!), args: words.slice(i + 1) };
}

// The strings in code, each with its backslash escapes undone.
const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs;

// Perl's quotes: `q(…)`, `qq{…}` and `qx[…]` a string, `qw(…)` a list of words.
const PERL_QUOTE = /\bq([qwx]?)\s*(?:\(([^)]*)\)|\{([^}]*)\}|\[([^\]]*)\]|<([^>]*)>|([^\w\s({[<])(.*?)\6)/gs;

// What the first command the code's strings spell out does that is refused,
// or null: each string read as a command line, as `os.system` or `execSync`
// would run it, and each list of strings separated only by commas and
// brackets as one command's words, as `subprocess.run` or `spawnSync` would.
// Strings within strings are read too, for code quoted inside a shell's. A
// string that only mentions a push, in a message, is refused as well.
async function refusedInCode(code: string, history: RunHistory): Promise<string | null> {
  const lists: string[][] = [];
  for (const [, kind, ...bodies] of code.matchAll(PERL_QUOTE)) {
    // The body inside whichever delimiters the quote took; the sixth group is a delimiter.
    const text = bodies.find((body, i) => body !== undefined && i !== 4) ?? '';
    lists.push(kind === 'w' ? text.split(/\s+/).filter(Boolean) : [text]);
  }
  let end = 0;
  for (const match of code.matchAll(STRING)) {
    const text = match[2]!.replace(/\\(.)/gs, '$1');
    if (lists.length && /^[\s,[\]()]*$/.test(code.slice(end, match.index))) lists.at(-1)!.push(text);
    else lists.push([text]);
    end = match.index + match[0].length;
  }
  for (const list of lists) {
    const what = list.length > 1 ? await refusedCommand(list, history) : null;
    if (what) return what;
    for (const text of list) {
      const inner = (await refusedIn(text, history)) ?? (await refusedInCode(text, history));
      if (inner) return inner;
    }
  }
  return null;
}

// What one simple command does that is refused, past any assignments and
// wrappers before it, and inside a shell's `-c` script.
async function refusedCommand(words: string[], history: RunHistory): Promise<string | null> {
  const { program, args } = programOf(words);
  if (SHELLS.has(program)) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    return flag >= 0 && args[flag + 1] !== undefined ? refusedIn(args[flag + 1]!, history) : null;
  }
  if (program === 'gh') return args.find((arg) => !arg.startsWith('-')) === 'auth' ? '`gh auth`' : null;
  return program === 'git' ? refusedGit(args, history) : null;
}

// The program a word runs, without its directory or `.exe`.
function programName(word: string): string {
  return word
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '');
}

// Git's own options that take the next word as their value.
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source']);

// What the git command, given its arguments after `git`, does that is refused.
async function refusedGit(args: string[], history: RunHistory): Promise<string | null> {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += GIT_VALUED.has(args[i]!) ? 2 : 1;
  const verb = args[i];
  const rest = args.slice(i + 1);
  const has = (...flags: string[]) => rest.some((arg) => flags.includes(arg));
  switch (verb) {
    case 'push':
    case 'send-pack':
      return '`git push`';
    case 'remote':
      return REMOTE_CHANGES.has(positionals(rest)[0] ?? '') ? 'Changing remotes' : null;
    case 'config':
      return configWrite(rest);
    case 'switch':
      return 'Switching branches';
    case 'checkout':
      return (await switchesBranch(rest, history)) ? 'Switching branches' : null;
    case 'symbolic-ref':
      return has('-d', '--delete') || positionals(rest, new Set(['-m'])).length >= 2 ? 'Switching branches' : null;
    case 'worktree':
      return '`git worktree`';
    case 'branch':
      return has('-f', '--force', '-D', '-M', '-C', '-m', '--move') ? 'Forcing, moving or renaming branches' : null;
    case 'tag':
      return has('-f', '--force') ? 'Forcing tags' : null;
    case 'update-ref':
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      return REWRITE;
    case 'reflog':
      return ['expire', 'delete'].includes(positionals(rest)[0] ?? '') ? REWRITE : null;
    case 'reset':
      return (await resetRewrites(rest, history)) ? REWRITE : null;
    case 'rebase':
      return rebaseRefusal(rest, history);
    case 'pull':
      return rest.some((arg) => arg === '-r' || arg === '--rebase' || (arg.startsWith('--rebase=') && arg !== '--rebase=false')) ? REWRITE : null;
    case 'commit':
      return has('--amend') && !(await history.keepsStart('HEAD~1')) ? REWRITE : null;
    default:
      return null;
  }
}

const REWRITE = 'Rewriting history from before this run';

// The words that aren't options, before any `--`, skipping the values of
// the options in `valued`.
function positionals(args: string[], valued: ReadonlySet<string> = new Set()): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (valued.has(args[i]!)) i++;
    else if (!args[i]!.startsWith('-') || args[i] === '-') words.push(args[i]!);
  }
  return words;
}

const CONFIG_WRITES = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--get-color', '--get-colorbool']);

// A config write to global or system config, or to a repo setting that
// changes where pushes go, how git authenticates, or which hooks run.
function configWrite(args: string[]): string | null {
  const words = positionals(args, new Set(['-f', '--file', '--blob', '--type', '--default', '--comment']));
  let key: string | undefined;
  if (['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(words[0] ?? '')) key = words[1] ?? '';
  else if (['get', 'list'].includes(words[0] ?? '') || args.some((arg) => CONFIG_READS.has(arg))) return null;
  else if (args.some((arg) => CONFIG_WRITES.has(arg)) || words.length >= 2) key = words[0] ?? '';
  else return null;
  if (args.includes('--global') || args.includes('--system')) return 'Writing global or system git config';
  const name = key.toLowerCase();
  const sensitive =
    ['remote.', 'url.', 'credential.', 'include.', 'includeif.'].some((section) => name.startsWith(section)) ||
    ['credential', 'core.hookspath', 'core.sshcommand'].includes(name);
  return sensitive ? 'Changing remote, url, credential, include or hook settings in git config' : null;
}

// `git checkout` moves HEAD unless it restores paths.
async function switchesBranch(args: string[], history: RunHistory): Promise<boolean> {
  if (args.some((arg) => ['-b', '-B', '--orphan', '--detach', '-'].includes(arg))) return true;
  if (args.includes('--')) return false;
  const words = positionals(args, new Set(['--pathspec-from-file']));
  return words.length === 1 && (await history.isCommit(words[0]!));
}

// `git reset <commit>` moves the branch; `git reset <paths>` doesn't.
async function resetRewrites(args: string[], history: RunHistory): Promise<boolean> {
  if (args.includes('-p') || args.includes('--patch')) return false;
  const [target] = positionals(args, new Set(['--pathspec-from-file']));
  return target !== undefined && (await history.isCommit(target)) && !(await history.keepsStart(target));
}

// `git rebase` rewrites what lies above its upstream, and onto `--onto`.
async function rebaseRefusal(args: string[], history: RunHistory): Promise<string | null> {
  if (args.some((arg) => ['--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch'].includes(arg))) return null;
  if (args.includes('--root')) return REWRITE;
  const ontoAt = args.indexOf('--onto');
  const onto = ontoAt >= 0 ? args[ontoAt + 1] : args.find((arg) => arg.startsWith('--onto='))?.slice('--onto='.length);
  const [upstream, branch] = positionals(args, new Set(['--onto', '-x', '--exec', '-s', '--strategy', '-X', '--strategy-option', '-C']));
  // A branch named after the upstream is checked out first.
  if (branch !== undefined) return 'Switching branches';
  for (const base of [upstream, onto]) if (base !== undefined && !(await history.keepsStart(base))) return REWRITE;
  return null;
}

// The simple commands in a command line, each as its words with quotes
// removed: split at `;`, `&`, `|`, newlines and parentheses, with each
// substituted command (`$(…)` or backticks) a command of its own and
// redirections dropped.
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  let redirected = false;
  const endWord = () => {
    if (word !== null && !redirected) words.push(word);
    if (word !== null) redirected = false;
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const substitute = (from: number): number => {
    // The matching `)`, counting nested parentheses.
    let depth = 1;
    let at = from;
    while (at < line.length && depth > 0) {
      if (line[at] === '(') depth++;
      else if (line[at] === ')') depth--;
      at++;
    }
    commands.push(...simpleCommands(line.slice(from, depth === 0 ? at - 1 : at)));
    return at;
  };
  const backticks = (from: number): number => {
    const end = line.indexOf('`', from);
    commands.push(...simpleCommands(line.slice(from, end < 0 ? line.length : end)));
    return end < 0 ? line.length : end + 1;
  };
  for (let i = 0; i < line.length; ) {
    const char = line[i]!;
    if (char === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end + 1;
    } else if (char === '"') {
      word ??= '';
      for (i++; i < line.length && line[i] !== '"'; ) {
        if (line[i] === '\\' && i + 1 < line.length) {
          word += line[i + 1];
          i += 2;
        } else if (line.startsWith('$(', i)) {
          i = substitute(i + 2);
        } else if (line[i] === '`') {
          i = backticks(i + 1);
        } else {
          word += line[i++];
        }
      }
      i++;
    } else if (char === '\\') {
      word = (word ?? '') + (line[i + 1] ?? '');
      i += 2;
    } else if (line.startsWith('$(', i)) {
      i = substitute(i + 2);
    } else if (char === '`') {
      i = backticks(i + 1);
    } else if (char === '>' || char === '<') {
      // A stream number before it is part of the redirection, and so is its target.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      while (line[i] === '>' || line[i] === '<') i++;
      if (line[i] === '&') while (/[&\d-]/.test(line[i] ?? '')) i++;
      else redirected = true;
    } else if (/[;&|\n()]/.test(char)) {
      endCommand();
      i++;
    } else if (/\s/.test(char)) {
      endWord();
      i++;
    } else {
      word = (word ?? '') + char;
      i++;
    }
  }
  endCommand();
  return commands;
}
