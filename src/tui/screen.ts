// Fitting the TUI to the terminal: its height, a pane's rows scrolled to keep
// the cursor's in view once the terminal is too short for them all, and a
// pane the operator pages through.
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

// A pane of what grows at its bottom, as a conversation does, that the
// operator pages through: it follows the latest rows, older ones scrolling off
// the top, until `up` scrolls it back. Scrolled back, it stays on the rows it
// shows as more come in, until `down` reaches the latest and it follows again.
export function usePager() {
  const pane = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(pane);
  const { height: total } = useBoxMetrics(content);
  // The content's row at the pane's top, or null while it follows the latest.
  const [scrolledTo, setScrolledTo] = useState<number | null>(null);
  // The top row of the last page: the furthest the pane scrolls.
  const lastTop = Math.max(total - height, 0);
  // Scrolled as far as the latest, as when the pane grows, it follows them again.
  const clamped = (to: number | null) => (to !== null && to < lastTop ? to : null);
  const top = clamped(scrolledTo);
  // A row of the last page stays in view on the next, to read on from.
  const page = Math.max(height - 1, 1);
  // Keys pressed in one burst arrive before a re-render: each pages on from the last.
  const scroll = (by: (top: number | null) => number | null) => setScrolledTo((to) => by(clamped(to)));
  return {
    // Whether there is more than the pane shows, to page through.
    overflows: lastTop > 0,
    scrolledBack: top !== null,
    up: () => scroll((top) => (lastTop === 0 ? null : Math.max((top ?? lastTop) - page, 0))),
    down: () => scroll((top) => (top === null || top + page >= lastTop ? null : top + page)),
    view: (...items: ReactNode[]) =>
      h(
        Box,
        {
          ref: pane,
          flexDirection: 'column',
          flexGrow: 1,
          overflow: 'hidden',
          justifyContent: top === null ? 'flex-end' : 'flex-start',
          contentOffsetY: top ?? 0,
        },
        h(Box, { ref: content, flexDirection: 'column', flexShrink: 0 }, ...items),
      ),
  };
}

function layoutOf(node: object | null | undefined): { top: number; height: number } | undefined {
  return (node as DOMElement | null | undefined)?.yogaNode?.getComputedLayout();
}
