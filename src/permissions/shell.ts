// A Bash command line read as the shell splits it, as far as the L1 gate
// and the hard denies need: its simple commands, each with its words, the
// files it writes, the heredoc that feeds it and the operator after it.
// Loops, conditions and groups are read through to the commands they run,
// and a loop over words it names runs its commands once for each.

export type SimpleCommand = {
  // Its text as written, without its redirections, for rules to match.
  text: string;
  // Its words, with quotes removed.
  words: string[];
  // The files its redirections write to, other than the null device and
  // the standard streams, and those among them it appends to.
  writes: string[];
  appends: string[];
  // The body of the heredoc that feeds it, if one does.
  heredoc: string | null;
  // The operator after it, a newline read as `;`, or null at the end.
  then: '&&' | '||' | ';' | '&' | '|' | null;
  // Whether it runs inside a loop, a condition or a group: perhaps more
  // than once, or not at all.
  compound: boolean;
};

// A loop, condition or group the line has opened. A `for` loop names its
// variable and the words it goes over, null when they can't be known.
type Block = { kind: 'loop' | 'if' | 'group'; variable: string | null; words: string[] | null; values?: string[] | null };

// What the line does, in order, for variables to expand as the shell would:
// assign one, surely or only perhaps (in a block, a pipe, the background or
// after `&&` or `||`), open a `for` loop, or run a command inside the blocks given.
type Step = { assign: [string, string]; surely: boolean } | { loop: Block } | { command: SimpleCommand; blocks: Block[] };

// A `$` quoted or escaped, which no variable expands from, while the line is read.
const LITERAL_DOLLAR = '';

// The heredocs whose bodies start on the next line, each with the command it
// feeds, by its index, and whether its delimiter was quoted, so that its body
// is taken as it is.
type Body = { delimiter: string; strip: boolean; quoted: boolean; command: number };

// The simple commands of `line`, chained by `&&`, `||`, `;`, `&`, `|` or
// newlines, or null when it substitutes commands, runs a subshell or can't be
// read: no rule can say what that does. Their words and writes have the
// variables the line sets, and its loops', expanded; their text doesn't.
export function readCommandLine(line: string): SimpleCommand[] | null {
  const commands: SimpleCommand[] = [];
  const steps: Step[] = [];
  const blocks: Block[] = [];
  // The command being read: where its text starts, the spans of its
  // redirections, its words so far, and the word being read.
  let start = 0;
  let cuts: [number, number][] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let appends: string[] = [];
  let word: string | null = null;
  let wordStart = 0;
  // What the next word is, after a redirection, and where that began.
  let target: { kind: 'write' | 'append' | 'read' | 'heredoc'; from: number; strip: boolean; quoted: boolean } | null = null;
  const bodies: Body[] = [];
  // The operator before the command being read.
  let after: SimpleCommand['then'] = null;
  let i = 0;

  const endWord = (end: number) => {
    if (word === null) return;
    if (target === null) words.push(word);
    else {
      cuts.push([target.from, end]);
      if (target.kind !== 'read' && target.kind !== 'heredoc' && !/^(\/dev\/(null|stdout|stderr)|nul)$/i.test(word)) {
        writes.push(word);
        if (target.kind === 'append') appends.push(word);
      }
      if (target.kind === 'heredoc') bodies.push({ delimiter: word.replaceAll(LITERAL_DOLLAR, '$'), strip: target.strip, quoted: target.quoted, command: commands.length });
      target = null;
    }
    word = null;
  };
  // False when a redirection is left without its target, or a block
  // closes one it doesn't match.
  const endCommand = (end: number, then: SimpleCommand['then']): boolean => {
    endWord(end);
    if (target !== null) return false;
    let text = '';
    let from = start;
    for (const [cutFrom, cutTo] of cuts) {
      text += line.slice(from, cutFrom);
      from = cutTo;
    }
    text += line.slice(from, end);
    // The words that open a block or go on with one come before the command.
    let lead = 0;
    for (; lead < words.length; lead++) {
      const word = words[lead]!;
      if (Object.hasOwn(OPENS, word)) blocks.push({ kind: OPENS[word]!, variable: null, words: null });
      else if (!GOES_ON.has(word)) break;
      text = text.trimStart().replace(/^\S+/, '');
    }
    words = words.slice(lead);
    const [first, ...rest] = words;
    let runs = words.length > 0 || writes.length > 0;
    if (first !== undefined && Object.hasOwn(CLOSES, first)) {
      if (rest.length || blocks.pop()?.kind !== CLOSES[first]) return false;
      words = [];
      runs = writes.length > 0;
    } else if (first === 'for') {
      // `for name in words`, or `for name` over the arguments, runs nothing itself.
      const [variable, keyword, ...over] = rest;
      if (!/^[A-Za-z_]\w*$/.test(variable ?? '') || (keyword !== undefined && keyword !== 'in') || writes.length) return false;
      const loop: Block = { kind: 'loop', variable: variable!, words: keyword === 'in' ? over : null };
      blocks.push(loop);
      steps.push({ loop });
      runs = false;
    } else if (words.length && !writes.length && words.every((word) => ASSIGNMENT.test(word))) {
      const surely = blocks.length === 0 && ![after, then].some((operator) => operator === '|' || operator === '&') && !['&&', '||'].includes(after ?? '');
      for (const word of words) steps.push({ assign: ASSIGNMENT.exec(word)!.slice(1) as [string, string], surely });
      runs = false;
    }
    if (runs) {
      const command: SimpleCommand = { text: text.trim(), words, writes, appends, heredoc: null, then, compound: blocks.length > 0 };
      commands.push(command);
      steps.push({ command, blocks: [...blocks] });
    } else for (const body of bodies) if (body.command === commands.length) body.command = -1;
    cuts = [];
    words = [];
    writes = [];
    appends = [];
    after = then;
    return true;
  };
  const append = (chars: string) => {
    if (word === null) wordStart = i;
    word = (word ?? '') + chars;
  };
  // Where a redirection's span begins: its stream number, and the blanks before.
  const spanFrom = (operatorAt: number) => {
    let from = word !== null && /^\d+$/.test(word) && wordStart + word.length === operatorAt ? wordStart : operatorAt;
    if (from !== operatorAt) word = null;
    endWord(operatorAt);
    while (from > start && /[ \t]/.test(line[from - 1]!)) from--;
    return from;
  };

  while (i < line.length) {
    const char = line[i]!;
    if (char === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      append(line.slice(i + 1, end).replaceAll('$', LITERAL_DOLLAR));
      i = end + 1;
    } else if (char === '"') {
      append('');
      let quoted = '';
      for (i++; i < line.length && line[i] !== '"'; ) {
        if (line[i] === '`' || line.startsWith('$(', i)) return null;
        if (line[i] === '\\' && /[$`"\\\n]/.test(line[i + 1] ?? '')) {
          if (line[i + 1] !== '\n') quoted += line[i + 1] === '$' ? LITERAL_DOLLAR : line[i + 1]!;
          i += 2;
        } else quoted += line[i++]!;
      }
      if (i >= line.length) return null;
      append(quoted);
      i++;
    } else if (char === '\\') {
      if (line[i + 1] !== '\n') append(line[i + 1] === '$' ? LITERAL_DOLLAR : (line[i + 1] ?? ''));
      i += 2;
    } else if (char === '`' || line.startsWith('$(', i) || line.startsWith('<(', i) || line.startsWith('>(', i) || char === '(' || char === ')') {
      return null;
    } else if (char === '#' && word === null) {
      while (i < line.length && line[i] !== '\n') i++;
    } else if (char === '>' || char === '<' || line.startsWith('&>', i)) {
      const from = spanFrom(i);
      const operator = /^(<<-|<<<|<<|<>|<&|>>|>\||>&|&>>|&>|<|>)/.exec(line.slice(i))![1]!;
      i += operator.length;
      if ((operator === '>&' || operator === '<&') && /^\s*(\d+|-)(?=[\s;&|)]|$)/.test(line.slice(i))) {
        // A stream duplicated onto another: nothing is written.
        i += /^\s*(\d+|-)/.exec(line.slice(i))![0].length;
        cuts.push([from, i]);
        continue;
      }
      const kind =
        operator.startsWith('<<') && operator !== '<<<'
          ? 'heredoc'
          : operator === '<' || operator === '<&' || operator === '<<<'
            ? 'read'
            : operator.endsWith('>>')
              ? 'append'
              : 'write';
      while (line[i] === ' ' || line[i] === '\t') i++;
      // A delimiter quoted anywhere keeps the shell out of the body.
      const quoted = /['"\\]/.test(/^[^\s;&|<>()]*/.exec(line.slice(i))![0]);
      target = { kind, from, strip: operator === '<<-', quoted };
    } else if (/[;&|\n]/.test(char)) {
      const operator = /^(&&|\|\||\|&|;;|[;&|\n])/.exec(line.slice(i))![1]!;
      if (!endCommand(i, operator === '\n' || operator === ';;' ? ';' : operator === '|&' ? '|' : (operator as SimpleCommand['then']))) return null;
      i += operator.length;
      if (operator === '\n') i = readBodies(line, i, bodies, commands);
      if (i < 0) return null;
      start = i;
    } else if (/\s/.test(char)) {
      endWord(i);
      i++;
    } else {
      append(char);
      i++;
    }
  }
  if (!endCommand(line.length, null) || bodies.length || blocks.length) return null;
  return expanded(steps);
}

// The words that open a block before a command, those that go on with one,
// and those that close one, alone in their command.
const OPENS: Readonly<Record<string, Block['kind']>> = { if: 'if', while: 'loop', until: 'loop', '{': 'group' };
const GOES_ON = new Set(['do', 'then', 'else', 'elif', '!']);
const CLOSES: Readonly<Record<string, Block['kind']>> = { done: 'loop', fi: 'if', '}': 'group' };

// The words that may come before a command it runs: `if`, `do` and the like.
export const KEYWORDS: ReadonlySet<string> = new Set([...Object.keys(OPENS), ...GOES_ON]);

const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s;

// A loop runs its commands once for each of at most this many words;
// beyond, its variable is left as it is written.
const MOST_VALUES = 64;

// The commands the steps run, each once for every value its loops give
// their variables, with the variables the line set before it expanded: one
// set to words splits into them, as unquoted it would. A variable the line
// doesn't set, sets more than once or only perhaps, or sets to what it can't
// know, is left as it is written, and so is a loop's the line also sets.
function expanded(steps: Step[]): SimpleCommand[] {
  // How surely each variable is set: 1 once and surely, more otherwise.
  const settings = new Map<string, number>();
  for (const step of steps) if ('assign' in step) settings.set(step.assign[0], (settings.get(step.assign[0]) ?? 0) + (step.surely ? 1 : 2));
  const assigned = new Map<string, string[] | null>();
  const commands: SimpleCommand[] = [];
  const literal = (word: string) => word.replaceAll(LITERAL_DOLLAR, '$');
  for (const step of steps) {
    if ('assign' in step) {
      const [name, value] = step.assign;
      assigned.set(name, settings.get(name) !== 1 || /[$`*?[]/.test(value) ? null : literal(value).split(/\s+/).filter(Boolean));
    } else if ('loop' in step) {
      const values = step.loop.words?.flatMap((word) => expandWord(word, new Map(), assigned));
      const known = values && values.length > 0 && values.length <= MOST_VALUES && !values.some((value) => value.includes('$'));
      step.loop.values = known && !settings.has(step.loop.variable!) ? values : null;
    } else {
      // Every combination of the values of the loops around the command.
      let bindings: Map<string, string>[] = [new Map()];
      for (const { variable, values } of step.blocks) {
        if (variable === null || !values) continue;
        bindings = bindings.flatMap((bound) => values.map((value) => new Map([...bound, [variable, value]])));
      }
      if (bindings.length > MOST_VALUES) bindings = [new Map()];
      const { command } = step;
      for (const bound of bindings) {
        const expand = (word: string) => expandWord(word, bound, assigned).map(literal);
        const path = (word: string) => expand(word).join(' ');
        commands.push({ ...command, words: command.words.flatMap(expand), writes: command.writes.map(path), appends: command.appends.map(path) });
      }
    }
  }
  return commands;
}

// A word with the variables it names expanded: `$name` or `${name}`, a loop's
// to its value, and a word that is only one set to words into those words.
function expandWord(word: string, bound: ReadonlyMap<string, string>, assigned: ReadonlyMap<string, string[] | null>): string[] {
  const alone = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(word);
  const name = alone?.[1] ?? alone?.[2];
  if (name !== undefined && !bound.has(name) && assigned.get(name)) return assigned.get(name)!;
  return [
    word.replace(/\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/g, (written, plain?: string, braced?: string) => {
      const variable = (plain ?? braced)!;
      return bound.get(variable) ?? assigned.get(variable)?.join(' ') ?? written;
    }),
  ];
}

// Reads the bodies of the heredocs started on the line before `from` onto
// the commands they feed, and returns where the line goes on after them, or
// -1 when one never ends, or substitutes commands the shell would run.
function readBodies(line: string, from: number, bodies: Body[], commands: SimpleCommand[]): number {
  let at = from;
  for (const { delimiter, strip, quoted, command } of bodies) {
    const lines: string[] = [];
    for (;;) {
      if (at >= line.length) return -1;
      const end = line.indexOf('\n', at);
      const text = line.slice(at, end < 0 ? line.length : end);
      at = end < 0 ? line.length : end + 1;
      if ((strip ? text.replace(/^\t+/, '') : text) === delimiter) break;
      lines.push(text);
    }
    const body = lines.join('\n');
    if (!quoted && /\$\(|`/.test(body)) return -1;
    if (command >= 0 && commands[command]) commands[command].heredoc = body;
  }
  bodies.length = 0;
  return at;
}
