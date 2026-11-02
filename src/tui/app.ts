// The TUI: Tasks, Needs you and Usage tabs fed by the factory-state subscription,
// the launch card (`N`), the conversation view (`enter` on a task), re-tiering
// a task (`t`), conversing with or taking over one (`c`), handing one off
// (`ctrl+h`), cancelling one with its subtree (`x`, with the cancel sheet
// when work would be lost), finishing a loop after its ticket (`f`), Needs
// you's answer sheet (`a`)
// and Set up now (`s`) or Re-check (`R`) for a repository without the skill
// set's setup.
// Plain .ts (no JSX) so Node runs it without a build step.
import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import type { AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import { TIERS, type Tier } from '../models/routing.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState, TaskView } from '../protocol/factory-state.ts';
import { openUrl as openInBrowser } from '../os/open-url.ts';
import type { CloneView, Command, Option } from '../protocol/protocol.ts';
import { SETUP_PRESET } from '../skills/repo-setup.ts';
import { AnswerSheet, answerable, useAnswering, waitingFor } from './answer-sheet.ts';
import { ChoosePrompt, chooseKey } from './choose.ts';
import { Conversation } from './conversation.ts';
import { LaunchCard } from './launch-card.ts';
import { UsageTab } from './usage.ts';

// Tab 3 is the Runs screen's, still to come.
type Tab = 'tasks' | 'needs-you' | 'usage';
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
// `openUrl` opens a fix in the operator's browser, such as the App's
// installation settings.
export function App({ connection, cwd, openUrl = openInBrowser }: { connection: FactoryConnection; cwd?: string; openUrl?: (url: string) => void }) {
  const [state, setState] = useState<FactoryState | null>(null);
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState<Tab>('tasks');
  const [clone, setClone] = useState<CloneView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'tabs' });
  // Each pane's cursor. It stays on the row it was on while the rows move,
  // so leaving a conversation comes back to exactly where the operator was.
  const [cursors, setCursors] = useState<Record<Tab, Cursor>>({
    tasks: { row: null, index: 0 },
    'needs-you': { row: null, index: 0 },
    usage: { row: null, index: 0 },
  });
  // Whether the digits answer the selected Needs you item instead of
  // switching screens. Once nothing needs the operator they switch again.
  const [answering, setAnswering] = useState(false);
  // Each task's last re-tier sent, from the tier it had then, until the
  // daemon's answer shows: a burst of `t` goes on from it.
  const retiers = useRef(new Map<string, { from: Tier; to: Tier }>());
  // The cancel sheet, open while the daemon asks what a cancel does with
  // work that would be lost: Keep branch or Discard work.
  const [cancelSheet, setCancelSheet] = useState<{ taskId: string; reason: string; options: Option[] } | null>(null);

  useEffect(() => connection.subscribe((next) => setState(next)), [connection]);
  useEffect(() => connection.onClose(() => setClosed(true)), [connection]);
  useEffect(() => {
    if (cwd === undefined) return;
    void connection.send({ type: 'inspectClone', path: cwd }).then((reply) => {
      if (reply.ok) setClone(reply.value as CloneView);
    });
  }, [connection, cwd]);
  const unregistered = clone && state && !(clone.repo in state.repositories) ? clone : null;
  const missingSetup = state ? withoutSetup(state, clone?.repo ?? null) : null;
  const tasks = state ? Object.values(state.tasks) : [];
  const queue = state?.attentionQueue ?? [];
  const rows = tab === 'tasks' ? tasks.map((task) => task.id) : tab === 'needs-you' ? queue.map(rowOf) : [];
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
  // The selected request's answer. The cursor stays where it is, so once the
  // request leaves Needs you the next item slides under it.
  const answers = useAnswering(connection, item, itemTask, {
    onSend: () => setCursors((cursors) => ({ ...cursors, 'needs-you': { row: null, index: at(cursors['needs-you'], rows) } })),
    onReply: ({ reply, taskId, opens }) => {
      setRefusal(reply.ok ? null : reply.reason);
      if (reply.ok && opens) setView({ kind: 'conversation', taskId });
    },
  });
  // Moves the selected task's next runs to the tier after its current one.
  const retier = () => {
    const task = tab === 'tasks' ? tasks[cursor] : undefined;
    if (!task) return;
    const pending = retiers.current.get(task.id);
    const from = pending?.from === task.tier ? pending.to : task.tier;
    const to = TIERS[(TIERS.indexOf(from) + 1) % TIERS.length]!;
    retiers.current.set(task.id, { from: task.tier, to });
    void connection.send({ type: 'retier', taskId: task.id, tier: to }).then((reply) => {
      setRefusal(reply.ok ? null : reply.reason);
      if (!reply.ok) retiers.current.delete(task.id);
    });
  };
  // Sends the verb, then opens the task's conversation once the daemon took it.
  const sendThenOpen = (command: Command & { taskId: string }) =>
    void connection.send(command).then((reply) => {
      setRefusal(reply.ok ? null : reply.reason);
      if (reply.ok) setView({ kind: 'conversation', taskId: command.taskId });
    });
  // Hands the selected HITL task off from its conversation, where the
  // handoff sheet opens: a parked one first resumes to write the brief.
  const handOff = () => {
    const task = tab === 'tasks' ? tasks[cursor] : undefined;
    if (task?.mode === 'HITL') sendThenOpen({ type: 'openHandoff', taskId: task.id });
  };
  // Converses with the selected task: a HITL one in its conversation, an AFK
  // one taken over into it.
  const converse = () => {
    const task = tab === 'tasks' ? tasks[cursor] : itemTask;
    if (task?.mode === 'HITL') setView({ kind: 'conversation', taskId: task.id });
    else if (task) sendThenOpen({ type: 'takeOver', taskId: task.id });
  };
  // Cancels the selected task and its subtree, or opens the cancel sheet on
  // what the daemon asks first.
  const cancel = (command: Option['command']) => {
    if (command.type !== 'cancel') return;
    const { taskId } = command;
    void connection.send(command).then((reply) => {
      const asks = !reply.ok && reply.choose?.length ? { taskId, reason: reply.reason, options: reply.choose } : null;
      setRefusal(reply.ok || asks ? null : reply.reason);
      setCancelSheet(asks);
    });
  };
  // Finish after this ticket: the selected task's loop ends once its live
  // iteration is done.
  const finishLoop = () => {
    const task = tab === 'tasks' ? tasks[cursor] : undefined;
    if (!task || !finishable(task)) return;
    void connection.send({ type: 'finishLoop', taskId: task.id }).then((reply) => setRefusal(reply.ok ? null : reply.reason));
  };
  // Set up now: the repository's `setup` task, one HITL run of the setup
  // skill, opened in its conversation.
  const setUp = () => {
    if (!missingSetup?.offered) return;
    void connection.send({ type: 'launchTask', repo: missingSetup.repo, preset: SETUP_PRESET }).then((reply) => {
      setRefusal(reply.ok ? null : reply.reason);
      if (reply.ok) setView({ kind: 'conversation', taskId: (reply.value as { taskId: string }).taskId });
    });
  };
  // Re-check: the daemon fetches the base branch and looks again, and the
  // repository's state shows the answer.
  const recheck = () => {
    if (!missingSetup) return;
    void connection.send({ type: 'checkSkills', repo: missingSetup.repo }).then((reply) => setRefusal(reply.ok ? null : reply.reason));
  };
  // Keys need raw mode, which a piped stdin can't give.
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (cancelSheet) {
        const picked = chooseKey(cancelSheet.options, input, key);
        if (picked) setCancelSheet(null);
        if (picked && picked !== 'back') cancel(picked.command);
        return;
      }
      if (answering && !item) setAnswering(false);
      else if (answering) {
        if (answers.form !== null || answers.confirm !== null) answers.key(input, key);
        else if (key.escape) setAnswering(false);
        else if (input === 'c') converse();
        else if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
        else if (key.return && opens) setView({ kind: 'conversation', taskId: opens });
        else answers.key(input, key);
        return;
      }
      if (tab === 'needs-you' && (input === 'a' || (key.return && answerable(item, itemTask)))) return setAnswering(true);
      if (input === '1') setTab('tasks');
      if (input === '2') setTab('needs-you');
      if (input === '4') setTab('usage');
      if (input === 'N' && state) setView({ kind: 'launch' });
      if (key.upArrow) move(-1);
      if (key.downArrow) move(1);
      if (key.return && opens) setView({ kind: 'conversation', taskId: opens });
      if (input === 't') retier();
      if (input === 'c') converse();
      const selected = tab === 'tasks' ? tasks[cursor] : undefined;
      if (input === 'x' && selected) cancel({ type: 'cancel', taskId: selected.id });
      if (input === 'f') finishLoop();
      if (key.ctrl && input === 'h') handOff();
      if (input === 's') setUp();
      if (input === 'R') recheck();
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
    missingSetup
      ? missingSetup.settingUp
        ? h(Text, { key: 'setup', dimColor: true }, `${missingSetup.repo} is being set up for the skill set in ${missingSetup.settingUp}.`)
        : h(
            Text,
            { key: 'setup', ...(missingSetup.offered ? { color: 'yellow' } : { dimColor: true }) },
            `${missingSetup.reason} `,
            ...(missingSetup.offered ? [h(Text, { key: 's', bold: true }, 's'), ' Set up now · '] : []),
            h(Text, { key: 'R', bold: true }, 'R'),
            ' re-check',
          )
      : null,
    refusal ? h(Text, { key: 'refusal', color: 'red' }, refusal) : null,
    cancelSheet
      ? h(ChoosePrompt, { key: 'cancel', reason: `Cancel ${cancelSheet.taskId}: ${cancelSheet.reason}`, options: cancelSheet.options.map(({ label }) => label) })
      : null,
    state && view.kind === 'launch'
      ? h(LaunchCard, {
          connection,
          state,
          here: clone?.repo ?? null,
          onLaunched: (taskId: string) => setView({ kind: 'conversation', taskId }),
          onCancel: toTabs,
          openUrl,
        })
      : null,
    state === null
      ? h(Text, { dimColor: true }, 'Attaching to the daemon…')
      : tab === 'tasks'
        ? h(TaskList, { tasks, cursor })
        : tab === 'needs-you'
          ? h(NeedsYouList, { state, cursor })
          : h(UsageTab, { state }),
    state && item ? h(AnswerSheet, { item, task: itemTask, card: answers.card, answering, form: answers.form, confirm: answers.confirm }) : null,
    closed ? h(Text, { color: 'red' }, 'The daemon connection closed.') : null,
  );
}

// The repository whose skill set setup isn't known to be there, as last
// checked: the one holding the working directory first, then any.
// `settingUp` is its unfinished `setup` task, if it has one; Set up now is
// `offered` only without one, and only when the check found the setup missing
// rather than failed to look.
function withoutSetup(
  state: FactoryState,
  here: string | null,
): { repo: string; reason: string; settingUp: string | null; offered: boolean } | null {
  const unset = Object.values(state.repositories).flatMap(({ id, skills }) => (skills && !skills.present ? [{ id, skills }] : []));
  const found = unset.find(({ id }) => id === here) ?? unset[0];
  if (!found) return null;
  const task = Object.values(state.tasks).find(
    (task) => task.repo === found.id && task.preset?.name === SETUP_PRESET && task.state !== 'done' && task.state !== 'cancelled',
  );
  const settingUp = task?.id ?? null;
  return { repo: found.id, reason: found.skills.reason, settingUp, offered: !settingUp && !found.skills.failed };
}

function Tabs({ tab, needsYou }: { tab: Tab; needsYou: number }) {
  const label = (key: Tab, text: string) =>
    h(Text, { key, bold: tab === key, inverse: tab === key }, ` ${text} `);
  return h(
    Box,
    { gap: 1, marginBottom: 1 },
    label('tasks', '1 Tasks'),
    label('needs-you', `2 Needs you (${needsYou})`),
    label('usage', '4 Usage'),
  );
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
  const finishes = finishable(tasks[cursor]) ? ' · f finish after this ticket' : '';
  return column([
    ...tasks.map((task, i) => h(Row, { key: task.id, id: task.id, title: task.title, detail: `${task.label} · ${task.tier}${loopDetail(task)}`, selected: i === cursor })),
    h(Text, { key: 'keys', dimColor: true }, `enter open · c converse or take over · t re-tier · x cancel${finishes} · N launch`),
  ]);
}

// Whether the task's Ralph loop can still be finished after its ticket.
function finishable(task: TaskView | undefined): boolean {
  return task?.mode === 'AFK' && !!task.loop && !task.loop.finishing;
}

// The ticket a task's loop works, and whether it ends after it.
function loopDetail({ loop }: TaskView): string {
  if (!loop) return '';
  if (!loop.ticket) return loop.finishing ? ' · finishing' : '';
  return ` · on ${loop.ticket}${loop.finishing ? ', finishing after it' : ''}`;
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
