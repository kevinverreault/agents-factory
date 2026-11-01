// A Bash command line read as the shell splits it, as far as the L1 gate
// and the hard denies need: its simple commands, each with its words, the
// files it writes, the heredoc that feeds it and the operator after it.

export type SimpleCommand = {
  // Its text as written, without its redirections, for rules to match.
  text: string;
  // Its words, with quotes removed.
  words: string[];
  // The files its redirections write to, other than the null device and
  // the standard streams.
  writes: string[];
  // The body of the heredoc that feeds it, if one does.
  heredoc: string | null;
  // The operator after it, a newline read as `;`, or null at the end.
  then: '&&' | '||' | ';' | '&' | '|' | null;
};

// The heredocs whose bodies start on the next line, each with the command it
// feeds, by its index, and whether its delimiter was quoted, so that its body
// is taken as it is.
type Body = { delimiter: string; strip: boolean; quoted: boolean; command: number };

// The simple commands of `line`, chained by `&&`, `||`, `;`, `&`, `|` or
// newlines, or null when it substitutes commands, runs a subshell or can't be
// read: no rule can say what that does.
export function readCommandLine(line: string): SimpleCommand[] | null {
  const commands: SimpleCommand[] = [];
  // The command being read: where its text starts, the spans of its
  // redirections, its words so far, and the word being read.
  let start = 0;
  let cuts: [number, number][] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let word: string | null = null;
  let wordStart = 0;
  // What the next word is, after a redirection, and where that began.
  let target: { kind: 'write' | 'read' | 'heredoc'; from: number; strip: boolean; quoted: boolean } | null = null;
  const bodies: Body[] = [];
  let i = 0;

  const endWord = (end: number) => {
    if (word === null) return;
    if (target === null) words.push(word);
    else {
      cuts.push([target.from, end]);
      if (target.kind === 'write' && !/^(\/dev\/(null|stdout|stderr)|nul)$/i.test(word)) writes.push(word);
      if (target.kind === 'heredoc') bodies.push({ delimiter: word, strip: target.strip, quoted: target.quoted, command: commands.length });
      target = null;
    }
    word = null;
  };
  // False when a redirection is left without its target.
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
    if (words.length || writes.length) commands.push({ text: text.trim(), words, writes, heredoc: null, then });
    else for (const body of bodies) if (body.command === commands.length) body.command = -1;
    cuts = [];
    words = [];
    writes = [];
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
      append(line.slice(i + 1, end));
      i = end + 1;
    } else if (char === '"') {
      append('');
      let quoted = '';
      for (i++; i < line.length && line[i] !== '"'; ) {
        if (line[i] === '`' || line.startsWith('$(', i)) return null;
        if (line[i] === '\\' && /[$`"\\\n]/.test(line[i + 1] ?? '')) {
          if (line[i + 1] !== '\n') quoted += line[i + 1]!;
          i += 2;
        } else quoted += line[i++]!;
      }
      if (i >= line.length) return null;
      append(quoted);
      i++;
    } else if (char === '\\') {
      if (line[i + 1] !== '\n') append(line[i + 1] ?? '');
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
      const kind = operator.startsWith('<<') && operator !== '<<<' ? 'heredoc' : operator === '<' || operator === '<&' || operator === '<<<' ? 'read' : 'write';
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
  if (!endCommand(line.length, null) || bodies.length) return null;
  return commands;
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
