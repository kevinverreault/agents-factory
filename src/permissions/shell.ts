// A Bash command line read as the shell splits it, as far as the L1 gate
// needs: its simple commands, each with its words, the files it writes and
// whether a heredoc feeds it.

export type SimpleCommand = {
  // Its text as written, without its redirections, for rules to match.
  text: string;
  // Its words, with quotes removed.
  words: string[];
  // The files its redirections write to, other than the null device.
  writes: string[];
  // Whether a heredoc feeds it.
  heredoc: boolean;
};

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
  let heredoc = false;
  let word: string | null = null;
  let wordStart = 0;
  // What the next word is, after a redirection, and where that began.
  let target: { kind: 'write' | 'read' | 'heredoc'; from: number; strip: boolean } | null = null;
  // The heredocs whose bodies start on the next line.
  const bodies: { delimiter: string; strip: boolean }[] = [];
  let i = 0;

  const endWord = (at: number) => {
    if (word === null) return;
    if (target === null) words.push(word);
    else {
      cuts.push([target.from, at]);
      if (target.kind === 'write' && !/^(\/dev\/null|nul)$/i.test(word)) writes.push(word);
      if (target.kind === 'heredoc') bodies.push({ delimiter: word, strip: target.strip });
      target = null;
    }
    word = null;
  };
  // False when a redirection is left without its target.
  const endCommand = (at: number): boolean => {
    endWord(at);
    if (target !== null) return false;
    let text = '';
    let from = start;
    for (const [cutFrom, cutTo] of cuts) {
      text += line.slice(from, cutFrom);
      from = cutTo;
    }
    text += line.slice(from, at);
    if (words.length || writes.length) commands.push({ text: text.trim(), words, writes, heredoc });
    cuts = [];
    words = [];
    writes = [];
    heredoc = false;
    return true;
  };
  const append = (chars: string) => {
    if (word === null) wordStart = i;
    word = (word ?? '') + chars;
  };
  // Where a redirection's span begins: its stream number, and the blanks before.
  const spanFrom = (at: number) => {
    let from = word !== null && /^\d+$/.test(word) && wordStart + word.length === at ? wordStart : at;
    if (from !== at) word = null;
    endWord(at);
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
      if (kind === 'heredoc') heredoc = true;
      target = { kind, from, strip: operator === '<<-' };
      while (line[i] === ' ' || line[i] === '\t') i++;
    } else if (/[;&|\n]/.test(char)) {
      if (!endCommand(i)) return null;
      i += /^(&&|\|\||\|&|;;)/.test(line.slice(i)) ? 2 : 1;
      if (char === '\n') i = afterBodies(line, i, bodies);
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
  if (!endCommand(line.length) || bodies.length) return null;
  return commands;
}

// Where the line goes on after the bodies of the heredocs started on the
// line before `from`, or -1 when one never ends.
function afterBodies(line: string, from: number, bodies: { delimiter: string; strip: boolean }[]): number {
  let at = from;
  for (const { delimiter, strip } of bodies) {
    for (;;) {
      if (at >= line.length) return -1;
      const end = line.indexOf('\n', at);
      const text = line.slice(at, end < 0 ? line.length : end);
      at = end < 0 ? line.length : end + 1;
      if ((strip ? text.replace(/^\t+/, '') : text) === delimiter) break;
    }
  }
  bodies.length = 0;
  return at;
}
