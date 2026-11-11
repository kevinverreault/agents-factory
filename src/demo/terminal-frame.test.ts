// The recorder's frame parser: a frame of Ink's output, chalk's SGR codes in
// it, as the rows of styled cells the renderer draws.
import { describe, expect, test } from 'vitest';
import { parseFrame, type Palette } from './terminal-frame.ts';

const palette: Palette = {
  foreground: '#ffffff',
  background: '#1a1a1a',
  ansi: ['#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff', '#808080', '#ff8080', '#80ff80', '#ffff80', '#8080ff', '#ff80ff', '#80ffff', '#fefefe'],
};

describe('parseFrame', () => {
  test('plain text is a cell a character, in the default colours', () => {
    const [row] = parseFrame('ab', palette);
    expect(row).toEqual([
      { char: 'a', fg: '#ffffff', bg: null, bold: false, dim: false, italic: false, underline: false, strike: false },
      { char: 'b', fg: '#ffffff', bg: null, bold: false, dim: false, italic: false, underline: false, strike: false },
    ]);
  });

  test('truecolour, the 16 colours and their resets colour the cells between them', () => {
    const [row] = parseFrame('\x1b[38;2;159;206;126ma\x1b[39mb\x1b[31mc\x1b[92md\x1b[48;2;1;2;3me\x1b[49mf', palette);
    expect(row!.map(({ char, fg, bg }) => [char, fg, bg])).toEqual([
      ['a', '#9fce7e', null],
      ['b', '#ffffff', null],
      ['c', '#ff0000', null],
      ['d', '#80ff80', null],
      ['e', '#80ff80', '#010203'],
      ['f', '#80ff80', null],
    ]);
  });

  test('bold, dim, italic, underline and strikethrough switch on and off, and 0 resets everything', () => {
    const [row] = parseFrame('\x1b[1;2ma\x1b[22m\x1b[3;4;9mb\x1b[23;24;29mc\x1b[1;31md\x1b[0me', palette);
    const styles = row!.map(({ bold, dim, italic, underline, strike }) => [bold, dim, italic, underline, strike]);
    expect(styles).toEqual([
      [true, true, false, false, false],
      [false, false, true, true, true],
      [false, false, false, false, false],
      [true, false, false, false, false],
      [false, false, false, false, false],
    ]);
    expect(row![4]!.fg).toBe('#ffffff');
  });

  test('inverse swaps the colours of the cells it covers', () => {
    const [row] = parseFrame('\x1b[38;2;10;20;30m\x1b[7ma\x1b[27mb', palette);
    expect(row!.map(({ fg, bg }) => [fg, bg])).toEqual([
      ['#1a1a1a', '#0a141e'],
      ['#0a141e', null],
    ]);
  });

  test('a style carries over a line break, and each line is a row', () => {
    const rows = parseFrame('\x1b[31ma\nb\x1b[39m\nc', palette);
    expect(rows.map((row) => row.map(({ char, fg }) => char + fg))).toEqual([['a#ff0000'], ['b#ff0000'], ['c#ffffff']]);
  });

  test('the 256 colours: their first 16 are the palette’s, then the colour cube and the greys', () => {
    const [row] = parseFrame('\x1b[38;5;1ma\x1b[38;5;196mb\x1b[38;5;244mc\x1b[48;5;9md', palette);
    expect(row!.map(({ char, fg, bg }) => [char, fg, bg])).toEqual([
      ['a', '#ff0000', null],
      ['b', '#ff0000', null],
      ['c', '#808080', null],
      ['d', '#808080', '#ff8080'],
    ]);
    // Read as a colour, the 1 isn’t also bold.
    expect(row![0]!.bold).toBe(false);
  });

  test('a character outside the basic plane is one cell, not two', () => {
    const [row] = parseFrame('a\u{1D465}b', palette);
    expect(row!.map(({ char }) => char)).toEqual(['a', '\u{1D465}', 'b']);
  });
});
