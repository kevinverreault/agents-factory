// The TUI: Tasks and Needs you tabs fed by the factory-state subscription,
// the launch card (`N`) and the conversation view (`enter` on a task). Plain
// .ts (no JSX) so Node runs it without a build step.
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, TaskView } from '../protocol/factory-state.ts';
import type { CloneView } from '../protocol/protocol.ts';
import { Conversation } from './conversation.ts';
import { LaunchCard } from './launch-card.ts';

type Tab = 'tasks' | 'needs-you';
// What fills the screen: the tabs, the launch card over them, or one task's
// conversation.
type View = { kind: 'tabs' } | { kind: 'launch' } | { kind: 'conversation'; taskId: string };
// The row a pane's cursor is on, and where it was, for when that row is gone.
type Cursor = { row: string | null; index: number };

function at({ row, index }: Cursor, rows: string[]): number {
  const found = row === null ? -1 : rows.indexOf(row);
  return found >= 0 ? found : Math.min(index, Math.max(rows.length - 1, 0));
}

// A Needs you row is its task's, or else its request's (about a repository).
function rowOf(item: AttentionQueueItem): string {
  return item.taskId ?? (item.kind === 'attention' ? item.requestId : '');
}

// `cwd` is the directory the TUI started in: started inside a clone that
// isn't registered, the TUI offers to register it (ADR 0010).
export function App({ connection, cwd }: { connection: FactoryConnection; cwd?: string }) {
  const [state, setState] = useState<FactoryState | null>(null);
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState<Tab>('tasks');
  const [clone, setClone] = useState<CloneView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'tabs' });
  // Each pane's cursor. It stays on the row it was on while the rows move,
  // so leaving a conversation comes back to exactly where the operator was.
  const [cursors, setCursors] = useState<Record<Tab, Cursor>>({ tasks: { row: null, index: 0 }, 'needs-you': { row: null, index: 0 } });

  useEffect(() => connection.subscribe((next) => setState(next)), [connection]);
  useEffect(() => connection.onClose(() => setClosed(true)), [connection]);
  useEffect(() => {
    if (cwd === undefined) return;
    void connection.send({ type: 'inspectClone', path: cwd }).then((reply) => {
      if (reply.ok) setClone(reply.value as CloneView);
    });
  }, [connection, cwd]);
  const unregistered = clone && state && !(clone.repo in state.repositories) ? clone : null;
  const tasks = state ? Object.values(state.tasks) : [];
  const queue = state?.attentionQueue ?? [];
  const rows = tab === 'tasks' ? tasks.map((task) => task.id) : queue.map(rowOf);
  const cursor = at(cursors[tab], rows);
  const moveTo = (index: number) => setCursors({ ...cursors, [tab]: { row: rows[index] ?? null, index } });
  // What enter opens: any task's conversation, or one Ready for you.
  const item = queue[cursor];
  const opens = tab === 'tasks' ? tasks[cursor]?.id : item?.kind === 'ready' ? item.taskId : undefined;

  // Keys need raw mode, which a piped stdin can't give.
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (input === '1') setTab('tasks');
      if (input === '2') setTab('needs-you');
      if (input === 'N' && state) setView({ kind: 'launch' });
      if (key.upArrow) moveTo(Math.max(cursor - 1, 0));
      if (key.downArrow) moveTo(Math.min(cursor + 1, rows.length - 1));
      if (key.return && opens) setView({ kind: 'conversation', taskId: opens });
      if (input === 'r' && unregistered) {
        void connection.send({ type: 'registerRepo', path: unregistered.path }).then((reply) => setRefusal(reply.ok ? null : reply.reason));
      }
    },
    { isActive: isRawModeSupported && view.kind === 'tabs' },
  );

  const toTabs = () => setView({ kind: 'tabs' });
  if (state && view.kind === 'conversation') {
    return h(Conversation, { connection, state, taskId: view.taskId, onLeave: toTabs });
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Tabs, { tab, needsYou: state?.attentionQueue.length ?? 0 }),
    unregistered
      ? h(Text, { key: 'register' }, `${unregistered.repo} is not registered. `, h(Text, { bold: true }, 'r'), ' Register this repo')
      : null,
    refusal ? h(Text, { key: 'refusal', color: 'red' }, refusal) : null,
    state && view.kind === 'launch'
      ? h(LaunchCard, {
          connection,
          state,
          here: clone?.repo ?? null,
          onLaunched: (taskId: string) => setView({ kind: 'conversation', taskId }),
          onCancel: toTabs,
        })
      : null,
    state === null
      ? h(Text, { dimColor: true }, 'Attaching to the daemon…')
      : tab === 'tasks'
        ? h(TaskList, { tasks, cursor })
        : h(NeedsYouList, { state, cursor }),
    closed ? h(Text, { color: 'red' }, 'The daemon connection closed.') : null,
  );
}

function Tabs({ tab, needsYou }: { tab: Tab; needsYou: number }) {
  const label = (key: Tab, text: string) =>
    h(Text, { key, bold: tab === key, inverse: tab === key }, ` ${text} `);
  return h(Box, { gap: 1, marginBottom: 1 }, label('tasks', '1 Tasks'), label('needs-you', `2 Needs you (${needsYou})`));
}

function Row({ id, title, detail, selected = false }: { id: string; title: string; detail: string; selected?: boolean }) {
  return h(
    Box,
    { gap: 1 },
    h(Text, { color: 'cyan' }, selected ? '›' : ' '),
    h(Text, { bold: true }, id.padEnd(4)),
    h(Box, { width: 40 }, h(Text, { wrap: 'truncate' }, title)),
    h(Text, null, detail),
  );
}

function TaskList({ tasks, cursor }: { tasks: TaskView[]; cursor: number }) {
  if (tasks.length === 0) return h(Text, { dimColor: true }, 'No tasks yet. N launches one.');
  return column(
    tasks.map((task, i) => h(Row, { key: task.id, id: task.id, title: task.title, detail: task.label, selected: i === cursor })),
  );
}

function NeedsYouList({ state, cursor }: { state: FactoryState; cursor: number }) {
  if (state.attentionQueue.length === 0) return h(Text, { dimColor: true }, 'Nothing needs you.');
  return column(
    state.attentionQueue.map((item, i) => {
      const key = item.kind === 'attention' ? item.requestId : `${item.kind}-${item.taskId}`;
      const { taskId } = item;
      const task = taskId === null ? undefined : state.tasks[taskId];
      // A request about a repository itself has no task: the repository takes the title's place.
      const title = task?.title ?? (item.kind === 'attention' ? item.repo : '');
      return h(Row, { key, id: taskId ?? '', title, detail: waitingFor(item, task), selected: i === cursor });
    }),
  );
}

// What the operator is asked for: the attention request, or else the task's
// own label (Ready for you, In review).
function waitingFor(item: AttentionQueueItem, task: TaskView | undefined): string {
  if (item.kind === 'attention') return item.reason ? `${item.attention}: ${item.reason}` : item.attention;
  return task?.label ?? '';
}

function column(children: ReactNode[]) {
  return h(Box, { flexDirection: 'column' }, ...children);
}
