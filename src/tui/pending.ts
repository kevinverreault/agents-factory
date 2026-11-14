// A command the daemon takes a while to answer, such as opening a handoff:
// one at a time, shown with a turning spinner and a label until the reply,
// so the screen never looks stuck. A key pressed again meanwhile sends nothing more.
import { createElement as h, useReducer, useRef, type ReactNode } from 'react';
import type { FactoryConnection } from '../protocol/client.ts';
import type { Command, Reply } from '../protocol/protocol.ts';
import { Spinner } from './theme.ts';

export type Pending = {
  // Sends `command`, shown as `label` until its reply, unless a command is
  // already under way: then it sends nothing and returns null.
  send(label: string, command: Command): Promise<Reply> | null;
  // Whether a command is under way: read when keys arrive, before a re-render.
  busy(): boolean;
  // The spinner while a command is under way, else nothing.
  indicator: ReactNode;
};

export function usePending(connection: FactoryConnection): Pending {
  const pending = useRef<string | null>(null);
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  return {
    send(label, command) {
      if (pending.current !== null) return null;
      pending.current = label;
      rerender();
      return connection.send(command).finally(() => {
        pending.current = null;
        rerender();
      });
    },
    busy: () => pending.current !== null,
    indicator: pending.current === null ? null : h(Spinner, { label: pending.current }),
  };
}
