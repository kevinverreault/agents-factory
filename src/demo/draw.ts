// Draws a frame of the TUI as a terminal window would show it, in the
// design system's colours (docs/windows-terminal-scheme.md), for the
// README's PNGs and GIFs. The rules, borders and bars are drawn as shapes,
// not glyphs, so they join up from cell to cell as they do in a terminal.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { parseFrame, toHex, type Cell, type Palette } from './terminal-frame.ts';

// The Windows Terminal scheme's colours, in ANSI order.
export const SCHEME: Palette = {
  foreground: '#ffffff',
  background: '#1a1a1a',
  ansi: ['#1a1a1a', '#f07575', '#53c67d', '#fab338', '#7fa7c9', '#d28c79', '#7fc4b8', '#ffffff', '#999999', '#f07575', '#9fce7e', '#fab338', '#7fa7c9', '#d28c79', '#7fc4b8', '#ffffff'],
};

const FONT_SIZE = 14;
const CELL_HEIGHT = 18;
const PADDING = 16;
const FAMILY = 'DejaVu Sans Mono';

// A cell’s width, once the fonts are loaded to measure it.
let cellWidth: number | null = null;
function loadFonts(): number {
  if (cellWidth !== null) return cellWidth;
  const ttf = join(dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  for (const file of ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf', 'DejaVuSansMono-Oblique.ttf', 'DejaVuSansMono-BoldOblique.ttf']) GlobalFonts.registerFromPath(join(ttf, file), FAMILY);
  // What the monospace face lacks, such as ✓ and ✗.
  GlobalFonts.registerFromPath(join(ttf, 'DejaVuSans.ttf'), 'DejaVu Sans');
  const probe = createCanvas(1, 1).getContext('2d');
  probe.font = `${FONT_SIZE}px "${FAMILY}"`;
  cellWidth = probe.measureText('M').width;
  return cellWidth;
}

// A canvas `columns` by `rows` cells, with the frame's first `rows` lines drawn on it.
export function drawFrame(frame: string, columns: number, rows: number): Canvas {
  const cellWidth = loadFonts();
  const canvas = createCanvas(Math.ceil(columns * cellWidth + 2 * PADDING), rows * CELL_HEIGHT + 2 * PADDING);
  const context = canvas.getContext('2d');
  context.fillStyle = SCHEME.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = 'middle';
  parseFrame(frame, SCHEME)
    .slice(0, rows)
    .forEach((line, row) =>
      line.slice(0, columns).forEach((cell, column) => {
        // Whole pixels, so neighbouring cells meet with no seam.
        const [left, right] = [column, column + 1].map((edge) => PADDING + Math.round(edge * cellWidth)) as [number, number];
        drawCell(context, cell, left, PADDING + row * CELL_HEIGHT, right - left);
      }),
    );
  return canvas;
}

function drawCell(context: SKRSContext2D, cell: Cell, x: number, y: number, width: number): void {
  const fg = cell.dim ? blend(cell.fg, cell.bg ?? SCHEME.background, 0.5) : cell.fg;
  if (cell.bg) {
    context.fillStyle = cell.bg;
    context.fillRect(x, y, width, CELL_HEIGHT);
  }
  if (cell.char === ' ') return;
  context.fillStyle = fg;
  context.strokeStyle = fg;
  context.lineWidth = 1;
  if (!drawShape(context, cell.char, x, y, width)) {
    context.font = `${cell.italic ? 'italic ' : ''}${cell.bold ? 'bold ' : ''}${FONT_SIZE}px "${FAMILY}", "DejaVu Sans"`;
    context.fillText(cell.char, x, y + CELL_HEIGHT / 2);
  }
  if (cell.underline) context.fillRect(x, y + CELL_HEIGHT - 3, width, 1);
  if (cell.strike) context.fillRect(x, y + CELL_HEIGHT / 2, width, 1);
}

// The eighth blocks, ▁ to █, by how many eighths of the cell each fills from the bottom.
const LOWER_BLOCKS = '▁▂▃▄▅▆▇█';

// Draws the box-drawing and block characters the TUI uses; false for any other.
function drawShape(context: SKRSContext2D, char: string, x: number, y: number, width: number): boolean {
  const midX = Math.floor(x + width / 2) + 0.5;
  const midY = Math.floor(y + CELL_HEIGHT / 2) + 0.5;
  const right = x + width;
  const bottom = y + CELL_HEIGHT;
  const line = (points: [number, number][]) => {
    context.beginPath();
    points.forEach(([px, py], i) => (i === 0 ? context.moveTo(px, py) : context.lineTo(px, py)));
    context.stroke();
  };
  const corner = (fromX: number, fromY: number, toX: number, toY: number) => {
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.quadraticCurveTo(midX, midY, toX, toY);
    context.stroke();
  };
  const eighths = LOWER_BLOCKS.indexOf(char) + 1;
  if (eighths > 0) {
    const height = (CELL_HEIGHT * eighths) / 8;
    context.fillRect(x, bottom - height, width, height);
    return true;
  }
  switch (char) {
    case '─':
      line([[x, midY], [right, midY]]);
      return true;
    case '│':
      line([[midX, y], [midX, bottom]]);
      return true;
    case '┌':
      line([[midX, bottom], [midX, midY], [right, midY]]);
      return true;
    case '┐':
      line([[x, midY], [midX, midY], [midX, bottom]]);
      return true;
    case '└':
      line([[midX, y], [midX, midY], [right, midY]]);
      return true;
    case '┘':
      line([[x, midY], [midX, midY], [midX, y]]);
      return true;
    case '╭':
      line([[midX, bottom], [midX, midY + 4]]);
      corner(midX, midY + 4, midX + 4, midY);
      line([[midX + 4, midY], [right, midY]]);
      return true;
    case '╮':
      line([[x, midY], [midX - 4, midY]]);
      corner(midX - 4, midY, midX, midY + 4);
      line([[midX, midY + 4], [midX, bottom]]);
      return true;
    case '╰':
      line([[midX, y], [midX, midY - 4]]);
      corner(midX, midY - 4, midX + 4, midY);
      line([[midX + 4, midY], [right, midY]]);
      return true;
    case '╯':
      line([[x, midY], [midX - 4, midY]]);
      corner(midX - 4, midY, midX, midY - 4);
      line([[midX, midY - 4], [midX, y]]);
      return true;
    case '░': {
      const style = context.fillStyle;
      context.globalAlpha = 0.3;
      context.fillRect(x, y + 1, width, CELL_HEIGHT - 2);
      context.globalAlpha = 1;
      context.fillStyle = style;
      return true;
    }
    case '▏':
      context.fillRect(x, y + 1, 2, CELL_HEIGHT - 2);
      return true;
    default:
      return false;
  }
}

function blend(from: string, to: string, by: number): string {
  const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const [a, b] = [channels(from), channels(to)];
  return toHex(a.map((value, i) => Math.round(value + (b[i]! - value) * by)));
}
