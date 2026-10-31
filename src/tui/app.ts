// The TUI: Tasks and Needs you tabs fed by the factory-state subscription,
// the launch card (`N`), the conversation view (`enter` on a task) and Needs
// you's answer sheet (`a`). Plain .ts (no JSX) so Node runs it without a
// build step.
import { createElement as h, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useStdin, type Key } from 'ink';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, TaskView } from '../protocol/factory-state.ts';
import type { CloneView, Command } from '../protocol/protocol.ts';
import { AnswerSheet, answerable, choicesFor, waitingFor } from './answer-sheet.ts';
import { Conversation } from './conversation.ts';
import { LaunchCard } from './launch-card.ts';
import { cardKey, newCard, type Card } from './question-card.ts';
import { edit } from './text-input.ts';

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
  // Whether the digits answer the selected Needs you item instead of
  // switching screens. Once nothing needs the operator they switch again.
  const [answering, setAnswering] = useState(false);
  // Keys typed in one burst arrive before a re-render, so the card the
  // operator is answering on, the note they are typing for a choice, and the
  // requests already answered, are kept here.
  const sheet = useRef<{
    card: Card;
    cardFor: string | null;
    note: { for: string; choice: number; draft: string } | null;
    sent: Set<string>;
  }>({ card: newCard(), cardFor: null, note: null, sent: new Set() });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);

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
  // By a step from where the cursor is now: keys typed in one burst arrive
  // before a re-render.
  const move = (by: number) =>
    setCursors((cursors) => {
      const index = Math.min(Math.max(at(cursors[tab], rows) + by, 0), Math.max(rows.length - 1, 0));
      return { ...cursors, [tab]: { row: rows[index] ?? null, index } };
    });
  // What enter opens: any task's conversation, or a live one Ready for you.
  const item = tab === 'needs-you' ? queue[cursor] : undefined;
  const itemTask = item?.taskId ? state?.tasks[item.taskId] : undefined;
  const ready = item?.kind === 'ready' ? itemTask : undefined;
  const opens = tab === 'tasks' ? tasks[cursor]?.id : ready?.liveRunId ? ready.id : undefined;
  const card = item?.kind === 'attention' && sheet.current.cardFor === item.requestId ? sheet.current.card : newCard();
  const note = item?.kind === 'attention' && sheet.current.note?.for === item.requestId ? sheet.current.note : null;

  // Sends what the operator answered the selected request with. The cursor
  // stays where it is, so once the request leaves Needs you the next item
  // slides under it.
  const sendAnswer = (command: Command, opens = false) => {
    if (item?.kind !== 'attention') return;
    const { requestId } = item;
    sheet.current.sent.add(requestId);
    setCursors((cursors) => ({ ...cursors, 'needs-you': { row: null, index: at(cursors['needs-you'], rows) } }));
    void connection.send(command).then((reply) => {
      setRefusal(reply.ok ? null : reply.reason);
      if (reply.ok && opens && item.taskId) setView({ kind: 'conversation', taskId: item.taskId });
      if (!reply.ok) {
        sheet.current.sent.delete(requestId);
        if (sheet.current.cardFor === requestId) sheet.current.card = newCard();
      }
      rerender();
    });
  };
  // A digit on the selected item's answer sheet: an option of its question's
  // card (toggled on a multi-select, which enter confirms), or a choice.
  const answer = (input: string, key: Key) => {
    if (item?.kind !== 'attention' || !item.taskId || sheet.current.sent.has(item.requestId)) return;
    if (item.question) {
      if (sheet.current.cardFor !== item.requestId) Object.assign(sheet.current, { card: newCard(), cardFor: item.requestId });
      const onCard = cardKey(item.question, sheet.current.card, '', input, key);
      if (onCard.kind === 'card') sheet.current.card = onCard.card;
      if (onCard.kind === 'answered') sendAnswer({ type: 'answer', taskId: item.taskId, answers: onCard.answers });
      rerender();
      return;
    }
    const index = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    const choice = choicesFor(item, itemTask)[index];
    if (choice && 'note' in choice) {
      sheet.current.note = { for: item.requestId, choice: index, draft: '' };
      rerender();
    } else if (choice) sendAnswer(choice.command, choice.opens);
  };
  // A key while the operator types the note a choice takes: enter sends it,
  // unless it is empty, and esc sets it aside.
  const takeNote = (input: string, key: Key) => {
    const choice = note && choicesFor(item!, itemTask)[note.choice];
    if (key.escape || !choice || !('note' in choice)) sheet.current.note = null;
    else if (key.return && note.draft.trim()) {
      sheet.current.note = null;
      sendAnswer(choice.note(note.draft.trim()));
    } else note.draft = edit(note.draft, input, key) ?? note.draft;
    rerender();
  };

  // Keys need raw mode, which a piped stdin can't give.
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (answering && !item) setAnswering(false);
      else if (answering) {
        if (note) takeNote(input, key);
        else if (key.escape) setAnswering(false);
        else if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
        else if (key.return && opens) setView({ kind: 'conversation', taskId: opens });
        else answer(input, key);
        return;
      }
      if (tab === 'needs-you' && (input === 'a' || (key.return && answerable(item, itemTask)))) return setAnswering(true);
      if (input === '1') setTab('tasks');
      if (input === '2') setTab('needs-you');
      if (input === 'N' && state) setView({ kind: 'launch' });
      if (key.upArrow) move(-1);
      if (key.downArrow) move(1);
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
    state && item ? h(AnswerSheet, { item, task: itemTask, card, answering, note: note?.draft ?? null }) : null,
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

function column(children: ReactNode[]) {
  return h(Box, { flexDirection: 'column' }, ...children);
}
