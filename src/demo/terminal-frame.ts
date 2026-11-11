// One frame of Ink's output as the rows of styled cells a terminal would
// show: the recorder draws these, so the README's media need no terminal.
// Only what chalk writes is read: SGR colours (truecolour, the 256 and the 16) and
// bold, dim, italic, underline, inverse and strikethrough.

export type Palette = {
  foreground: string;
  background: string;
  // The 16 ANSI colours: black, red, green, yellow, blue, magenta, cyan,
  // white, then their bright ones.
  ansi: readonly string[];
};

export type Cell = {
  char: string;
  fg: string;
  // Null where the terminal's own background shows.
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
};

type Style = { fg: string | null; bg: string | null; bold: boolean; dim: boolean; italic: boolean; underline: boolean; strike: boolean; inverse: boolean };

const PLAIN: Style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };
const SGR = /\x1b\[([\d;]*)m/y;

export function parseFrame(frame: string, palette: Palette): Cell[][] {
  const rows: Cell[][] = [[]];
  let style = { ...PLAIN };
  for (let at = 0; at < frame.length; ) {
    SGR.lastIndex = at;
    const sgr = SGR.exec(frame);
    if (sgr) {
      style = applySgr(style, sgr[1]!, palette);
      at = SGR.lastIndex;
      continue;
    }
    const char = String.fromCodePoint(frame.codePointAt(at)!);
    at += char.length;
    if (char === '\n') rows.push([]);
    else rows.at(-1)!.push(cell(char, style, palette));
  }
  return rows;
}

function cell(char: string, style: Style, palette: Palette): Cell {
  const fg = style.fg ?? palette.foreground;
  const { bold, dim, italic, underline, strike } = style;
  if (style.inverse) return { char, fg: style.bg ?? palette.background, bg: fg, bold, dim, italic, underline, strike };
  return { char, fg, bg: style.bg, bold, dim, italic, underline, strike };
}

function applySgr(from: Style, params: string, palette: Palette): Style {
  const codes = params === '' ? [0] : params.split(';').map(Number);
  const style = { ...from };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) Object.assign(style, PLAIN);
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 22) style.bold = style.dim = false;
    else if (code === 3) style.italic = true;
    else if (code === 23) style.italic = false;
    else if (code === 4) style.underline = true;
    else if (code === 24) style.underline = false;
    else if (code === 7) style.inverse = true;
    else if (code === 27) style.inverse = false;
    else if (code === 9) style.strike = true;
    else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.fg = palette.ansi[code - 30]!;
    else if (code >= 90 && code <= 97) style.fg = palette.ansi[code - 90 + 8]!;
    else if (code >= 40 && code <= 47) style.bg = palette.ansi[code - 40]!;
    else if (code >= 100 && code <= 107) style.bg = palette.ansi[code - 100 + 8]!;
    else if (code === 39) style.fg = null;
    else if (code === 49) style.bg = null;
    else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
      const hex = toHex(codes.slice(i + 2, i + 5));
      if (code === 38) style.fg = hex;
      else style.bg = hex;
      i += 4;
    } else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
      const hex = colour256(codes[i + 2] ?? 0, palette);
      if (code === 38) style.fg = hex;
      else style.bg = hex;
      i += 2;
    }
  }
  return style;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

// One of the 256 colours: the palette’s 16, then a 6×6×6 cube, then 24 greys.
function colour256(n: number, palette: Palette): string {
  if (n < 16) return palette.ansi[n]!;
  if (n >= 232) return toHex(Array(3).fill(8 + 10 * (n - 232)));
  const cube = n - 16;
  return toHex([CUBE_LEVELS[Math.floor(cube / 36)]!, CUBE_LEVELS[Math.floor(cube / 6) % 6]!, CUBE_LEVELS[cube % 6]!]);
}

// Red, green and blue, 0 to 255 each, as #rrggbb.
export function toHex(channels: number[]): string {
  return '#' + channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

// A frame with its SGR codes taken out: what it says, unstyled.
export function plainText(frame: string): string {
  return frame.replace(/\x1b\[[\d;]*m/g, '');
}
