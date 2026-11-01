// The L1 gate's rules (ADR 0007): which tool calls an AFK run may make
// without asking the operator. They come from the factory's own allow list,
// the operator's permissions file and the task, never from the target repo.
// Rules use Claude Code's syntax: `Tool`, or `Tool(specifier)`. Bash rules
// are best-effort, not a security boundary: L1 guards against accidents.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { parse } from 'yaml';

// A tool call Claude Code asked about. `summary` is what it is pointed at, on one line.
export type ToolCall = { id: string; tool: string; input: Record<string, unknown>; summary: string };

// What the factory lets every L1 run do. Edits in the worktree are accepted
// by the run's permission mode, and Claude Code runs what it considers
// read-only without asking. The factory's MCP tools join once L1 runs get
// the factory server, gated on its provenance.
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
  // Common read-only shell commands, none with an option that writes.
  ...['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'echo', 'pwd', 'which', 'diff', 'file', 'stat', 'du', 'df'].map(
    (command) => `Bash(${command} *)`,
  ),
];

// The operator's own allow rules, from their permissions file:
//
//   allow:
//     - Bash(make *)
//
// No file grants nothing. `error` says why a file that can't be read or
// doesn't hold a list of rules grants nothing either.
export function readOperatorRules(path: string): { rules: string[]; error: string | null } {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [], error: null };
    return { rules: [], error: `${path} couldn’t be read: ${(error as Error).message}` };
  }
  const allow = (raw as { allow?: unknown } | null)?.allow ?? [];
  if (!Array.isArray(allow) || !allow.every(isRule)) {
    return { rules: [], error: `${path} must hold \`allow:\`, a list of rules such as \`Bash(make *)\`.` };
  }
  return { rules: allow, error: null };
}

// The parts of the call no rule covers, each a call of its own: the commands
// of a Bash chain (`&&`, `||`, `;`, `&` or `|`), less what they redirect to
// a stream or the null device, or else the call itself. A Bash command that
// can't be split is one part, which only its exact rule covers. None when
// the rules cover the call.
export function uncovered(rules: readonly string[], call: ToolCall): ToolCall[] {
  const parsed = rules.flatMap((rule) => parseRule(rule) ?? []).filter((rule) => toolMatches(rule.tool, call.tool));
  if (parsed.some((rule) => rule.specifier === null)) return [];
  if (call.tool === 'Bash') {
    const command = String(call.input.command ?? '');
    const parts = commandParts(command);
    if (parts === null) return parsed.some((rule) => rule.specifier === command.trim()) ? [] : [call];
    const left = parts.filter((part) => !parsed.some((rule) => bashMatches(rule.specifier!, part)));
    return left.map((part) => (parts.length === 1 ? call : { ...call, input: { ...call.input, command: part }, summary: part }));
  }
  if (call.tool === 'WebFetch') {
    const host = hostOf(call.input.url);
    return host !== null && parsed.some((rule) => rule.specifier!.startsWith('domain:') && glob(rule.specifier!.slice(7)).test(host)) ? [] : [call];
  }
  const target = targetOf(call.input);
  return target !== null && parsed.some((rule) => glob(slashed(rule.specifier!)).test(posix.normalize(slashed(target)))) ? [] : [call];
}

// The rule Allow for this task proposes for a part no rule covers: a Bash
// command's program and its subcommand or leading option, with any
// arguments (`Bash(npm install *)`, `Bash(sed -i *)`). An interpreter's
// pattern names the script it runs (`Bash(node scripts/seed.js *)`), and
// inline code gets its exact command, as does a command that can't be
// split, and a call to any other tool its own rule.
export function patternFor(part: Pick<ToolCall, 'tool' | 'input'>): string {
  const parts = part.tool === 'Bash' ? commandParts(String(part.input.command ?? '')) : null;
  if (parts?.length !== 1) return ruleFor(part);
  const [program = '', next] = parts[0]!.split(/\s+/);
  if (INTERPRETERS.has(program) && next !== undefined) {
    if (INLINE_CODE.test(next)) return `Bash(${parts[0]})`;
    if (!next.startsWith('-')) return `Bash(${program} ${next} *)`;
  }
  const words = next !== undefined && /^-{0,2}[A-Za-z][\w-]*$/.test(next) ? [program, next] : [program];
  return `Bash(${words.join(' ')} *)`;
}

// Programs that run a script or inline code they are given, and the options
// that give them inline code.
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd', 'node', 'deno', 'python', 'python3', 'ruby', 'perl']);
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

// The parts of a command chained by operators, or null when it substitutes
// commands or redirects anywhere but to another stream or the null device:
// no specifier can say what that does.
function commandParts(command: string): string[] | null {
  const plain = command.replace(/\s*\d?>\s*(?:&\d|\/dev\/null|nul)(?=\s|$)/gi, '');
  if (/\$\(|`|<\(|>\(|[<>]/.test(plain)) return null;
  return plain
    .split(/&&|\|\||[;&|\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
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
