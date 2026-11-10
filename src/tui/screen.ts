// Fitting the TUI to the terminal: its height, and a pane's rows scrolled to
// keep the cursor's in view once the terminal is too short for them all.
import { createElement as h, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Box, useBoxMetrics, useStdout, type DOMElement } from 'ink';
// The terminal's rows, again on every resize. Unknown, as when stdout isn't
// a terminal, the TUI takes the height its content does.
export function useRows(): number | undefined {
  const { stdout } = useStdout();
  const [, resized] = useReducer((resizes: number) => resizes + 1, 0);
  useEffect(() => {
    stdout.on('resize', resized);
    return () => void stdout.off('resize', resized);
  }, [stdout]);
  return (stdout as NodeJS.WriteStream).rows || undefined;
}

// The terminal's columns, again on every resize. Unknown, the TUI takes a
// wide one: the width it is designed for.
export const DESIGNED_COLUMNS = 120;
export function useColumns(): number {
  const { stdout } = useStdout();
  const [, resized] = useReducer((resizes: number) => resizes + 1, 0);
  useEffect(() => {
    stdout.on('resize', resized);
    return () => void stdout.off('resize', resized);
  }, [stdout]);
  return (stdout as NodeJS.WriteStream).columns || DESIGNED_COLUMNS;
}

// What stays whole on a short screen: the screen's pane clips it instead of
// squeezing it.
export function fixed(...children: ReactNode[]) {
  return h(Box, { flexDirection: 'column', flexShrink: 0 }, ...children);
}

// `items` in a pane that gives way when the screen is short: it scrolls only
// as far as keeps item `cursor` in view, items that wrap included.
export function CursorWindow({ cursor, items }: { cursor: number; items: ReactNode[] }) {
  const pane = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(pane);
  const [offset, setOffset] = useState(0);
  // After every render: the layout it reads is the one just drawn.
  useEffect(() => {
    const item = layoutOf(content.current?.childNodes[cursor]);
    const total = layoutOf(content.current)?.height ?? 0;
    if (!item || !height) return;
    setOffset((offset) => {
      const down = Math.max(offset, item.top + item.height - height);
      // An item taller than the pane shows its first rows.
      const up = Math.min(down, item.top);
      return Math.min(Math.max(up, 0), Math.max(total - height, 0));
    });
  });
  return h(
    Box,
    { ref: pane, flexDirection: 'column', flexShrink: 1, overflow: 'hidden', contentOffsetY: offset },
    h(Box, { ref: content, flexDirection: 'column', flexShrink: 0 }, ...items),
  );
}

function layoutOf(node: object | null | undefined): { top: number; height: number } | undefined {
  return (node as DOMElement | null | undefined)?.yogaNode?.getComputedLayout();
}
