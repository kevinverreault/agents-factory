// The bare TUI: Tasks and Needs you tabs fed by the factory-state
// subscription. Plain .ts (no JSX) so Node runs it without a build step.
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, TaskView } from '../protocol/factory-state.ts';
import type { CloneView } from '../protocol/protocol.ts';

type Tab = 'tasks' | 'needs-you';

// `cwd` is the directory the TUI started in: started inside a clone that
// isn't registered, the TUI offers to register it (ADR 0010).
export function App({ connection, cwd }: { connection: FactoryConnection; cwd?: string }) {
  const [state, setState] = useState<FactoryState | null>(null);
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState<Tab>('tasks');
  const [clone, setClone] = useState<CloneView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => connection.subscribe((next) => setState(next)), [connection]);
  useEffect(() => connection.onClose(() => setClosed(true)), [connection]);
  useEffect(() => {
    if (cwd === undefined) return;
    void connection.send({ type: 'inspectClone', path: cwd }).then((reply) => {
      if (reply.ok) setClone(reply.value as CloneView);
    });
  }, [connection, cwd]);
  const unregistered = clone && state && !(clone.repo in state.repositories) ? clone : null;

  // Keys need raw mode, which a piped stdin can't give.
  const { isRawModeSupported } = useStdin();
  useInput(
    (input) => {
      if (input === '1') setTab('tasks');
      if (input === '2') setTab('needs-you');
      if (input === 'r' && unregistered) {
        void connection.send({ type: 'registerRepo', path: unregistered.path }).then((reply) => setRefusal(reply.ok ? null : reply.reason));
      }
    },
    { isActive: isRawModeSupported },
  );

  return h(
    Box,
    { flexDirection: 'column' },
    h(Tabs, { tab, needsYou: state?.attentionQueue.length ?? 0 }),
    unregistered
      ? h(Text, { key: 'register' }, `${unregistered.repo} is not registered. `, h(Text, { bold: true }, 'r'), ' Register this repo')
      : null,
    refusal ? h(Text, { key: 'refusal', color: 'red' }, refusal) : null,
    state === null
      ? h(Text, { dimColor: true }, 'Attaching to the daemon…')
      : tab === 'tasks'
        ? h(TaskList, { tasks: Object.values(state.tasks) })
        : h(NeedsYouList, { state }),
    closed ? h(Text, { color: 'red' }, 'The daemon connection closed.') : null,
  );
}

function Tabs({ tab, needsYou }: { tab: Tab; needsYou: number }) {
  const label = (key: Tab, text: string) =>
    h(Text, { key, bold: tab === key, inverse: tab === key }, ` ${text} `);
  return h(Box, { gap: 1, marginBottom: 1 }, label('tasks', '1 Tasks'), label('needs-you', `2 Needs you (${needsYou})`));
}

function Row({ id, title, detail }: { id: string; title: string; detail: string }) {
  return h(
    Box,
    { gap: 2 },
    h(Text, { bold: true }, id.padEnd(4)),
    h(Box, { width: 40 }, h(Text, { wrap: 'truncate' }, title)),
    h(Text, null, detail),
  );
}

function TaskList({ tasks }: { tasks: TaskView[] }) {
  if (tasks.length === 0) return h(Text, { dimColor: true }, 'No tasks yet.');
  return column(tasks.map((task) => h(Row, { key: task.id, id: task.id, title: task.title, detail: task.label })));
}

function NeedsYouList({ state }: { state: FactoryState }) {
  if (state.attentionQueue.length === 0) return h(Text, { dimColor: true }, 'Nothing needs you.');
  return column(
    state.attentionQueue.map((item) => {
      const key = item.kind === 'attention' ? item.requestId : `${item.kind}-${item.taskId}`;
      const { taskId } = item;
      const task = taskId === null ? undefined : state.tasks[taskId];
      // A request about a repository itself has no task: the repository takes the title's place.
      const title = task?.title ?? (item.kind === 'attention' ? item.repo : '');
      return h(Row, { key, id: taskId ?? '', title, detail: waitingFor(item, task) });
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
