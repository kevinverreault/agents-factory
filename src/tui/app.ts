// The TUI: the screens view, its Tasks, Needs you, Runs and Usage screens
// (`1`–`4`) fed by the factory-state subscription, with a task's detail
// drilled into (`enter`) and popped back out of (`esc`); the task tree with
// the selected task's output under it, and its Done and Cancelled tasks
// dimmed or hidden (`H`); the launch card (`N`), quick launch (`n`), the conversation view
// (`enter` in a task's detail), re-tiering a task (`t`), conversing with or
// taking over one (`c`), handing one off (`ctrl+h`), cancelling one with its
// subtree (`x`, with the cancel sheet when work would be lost), finishing a
// loop after its ticket (`F`), retrying a failed task from the tree (`y`),
// answering its request on Needs you's answer sheet (`a`), `?` help, and Set
// up now (`s`) or Re-check (`R`) for a repository without the skill set's
// setup. Over the same state, the condensed view (`v`): Needs you and the
// groups, the task tree and the selected task's detail side by side, `tab`
// moving the focus and `f` zooming the detail. The group picker (`g`) and
// the `:` command line (`:task 9`, `:group billing`) jump anywhere, and
// `:gc` opens the gc sheet on what belongs to no live task.
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
import { AnswerSheet, answerable, askedFor, reopens, titleOf, useAnswering } from './answer-sheet.ts';
import { ChoosePrompt, chooseKey } from './choose.ts';
import { CommandLine, runCommand, type Jump } from './command-line.ts';
import { Condensed, groupCounts, PANES, Sidebar, type Pane } from './condensed.ts';
import { GcSheet } from './gc-sheet.ts';
import { GroupPicker, pickerKey } from './group-picker.ts';
import { Conversation } from './conversation.ts';
import { Help } from './help.ts';
import { LaunchCard } from './launch-card.ts';
import { Output } from './output.ts';
import { QuickLaunch } from './quick-launch.ts';
import { liveFirst, RunsList } from './runs.ts';
import { CursorWindow, fixed, useColumns, useRows } from './screen.ts';
import { modeOf, TaskDetail } from './task-detail.ts';
import { edit } from './text-input.ts';
import { Cursor, filled, GLYPH, joined, kindLook, Keys, Rule, stateLook, tone, type Hint } from './theme.ts';
import { UsageStrip, UsageTab } from './usage.ts';

// The screens, in the order of the number keys that switch to them.
const TABS = ['tasks', 'needs-you', 'runs', 'usage'] as const;
type Tab = (typeof TABS)[number];
const TAB_NAMES: Record<Tab, string> = { tasks: 'Tasks', 'needs-you': 'Needs you', runs: 'Runs', usage: 'Usage' };
// What fills the screen: the screens, the launch card, quick launch or the
// gc sheet over them, or one task's conversation.
type View = { kind: 'tabs' } | { kind: 'launch' } | { kind: 'quick' } | { kind: 'gc' } | { kind: 'conversation'; taskId: string };
// How many of the selected task's latest events the pane under the task tree shows.
const OUTPUT_PANE_LINES = 6;
// The screen's pane's weight in giving way against the quick launch card's 1:
// enough that the card keeps all but a fraction of a row until the pane is gone.
const PANE_GIVES_WAY_FIRST = 1000;
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
  // The task whose detail `enter` drilled into over the screen, until `esc`
  // pops back to it.
  const [detail, setDetail] = useState<string | null>(null);
  // Whether the task tree hides Done and Cancelled tasks.
  const [hideFinished, setHideFinished] = useState(false);
  // Whether `?` help is open.
  const [help, setHelp] = useState(false);
  // Whether the condensed view (`v`) shows instead of the screens, and
  // whether its detail is zoomed (`f`) to the whole width.
  const [condensed, setCondensed] = useState(false);
  const [zoom, setZoom] = useState(false);
  // The group the task tree is filtered by, and the group picker's cursor
  // while `g` has it open, in a ref too for keys typed in one burst.
  const [group, setGroup] = useState<string | null>(null);
  const pickerAt = useRef<number | null>(null);
  const [pickerCursor, setPickerState] = useState<number | null>(null);
  const setPickerCursor = (cursor: number | null) => {
    pickerAt.current = cursor;
    setPickerState(cursor);
  };
  // The `:` command line's draft while it is open. Keys typed in one burst
  // arrive before a re-render, so each goes on from the last in the ref.
  const draft = useRef<string | null>(null);
  const [command, setCommandState] = useState<string | null>(null);
  const setCommand = (line: string | null) => {
    draft.current = line;
    setCommandState(line);
  };
  const [clone, setClone] = useState<CloneView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'tabs' });
  // Each pane's cursor. It stays on the row it was on while the rows move,
  // so leaving a conversation comes back to exactly where the operator was.
  const [cursors, setCursors] = useState<Record<Tab, Cursor>>({
    tasks: { row: null, index: 0 },
    'needs-you': { row: null, index: 0 },
    runs: { row: null, index: 0 },
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
  // The task tree: each root, then its descendants under it.
  const tree = state ? treeOrder(Object.values(state.tasks)) : [];
  const grouped = group === null ? tree : keepingAncestors(tree, (task) => task.groups.includes(group));
  const tasks = hideFinished ? keepingAncestors(grouped, (task) => !finished(task)) : grouped;
  const groups = groupCounts(tree);
  const queue = state?.attentionQueue ?? [];
  const runs = state ? liveFirst(state) : [];
  const rows = tab === 'tasks' ? tasks.map((task) => task.id) : tab === 'needs-you' ? queue.map(rowOf) : tab === 'runs' ? runs.map((run) => run.id) : [];
  const cursor = at(cursors[tab], rows);
  // By a step from where the cursor is now: keys typed in one burst arrive
  // before a re-render.
  const move = (by: number) =>
    setCursors((cursors) => {
      const index = Math.min(Math.max(at(cursors[tab], rows) + by, 0), Math.max(rows.length - 1, 0));
      return { ...cursors, [tab]: { row: rows[index] ?? null, index } };
    });
  // The task drilled into, while the daemon still has it.
  const drilled = detail ? state?.tasks[detail] : undefined;
  // The task the verbs act on: the one drilled into, or the one under the
  // cursor on the Tasks screen, or whose run it is on the Runs screen.
  const onRun = tab === 'runs' ? runs[cursor] : undefined;
  const selected = drilled ?? (tab === 'tasks' ? tasks[cursor] : onRun && state?.tasks[onRun.taskId]);
  const item = tab === 'needs-you' && !drilled ? queue[cursor] : undefined;
  const itemTask = item?.taskId ? state?.tasks[item.taskId] : undefined;
  const ready = item?.kind === 'ready' ? itemTask : undefined;
  // What enter opens: a drilled-into task's conversation, or one Ready for
  // you, live or to reopen. On the Tasks and Runs screens it drills in instead.
  const opens = drilled ? drilled.id : ready?.liveRunId || reopens(ready) ? ready!.id : undefined;
  const drills = drilled || tab === 'needs-you' ? undefined : selected?.id;
  // In the condensed view the focus is where the screens' state is: on a
  // task drilled into, the detail; on Needs you, the sidebar; else the tree.
  // The detail pane follows the selection: the task drilled into, or the
  // one the focused pane's cursor is on.
  const focus: Pane = drilled ? 'detail' : tab === 'needs-you' ? 'sidebar' : 'tree';
  const followed = selected ?? itemTask;
  // With no task to show, the detail is skipped.
  const nextPane = () => {
    const next = PANES[(PANES.indexOf(focus) + 1) % PANES.length]!;
    if (next !== 'detail') {
      setDetail(null);
      setTab(next === 'sidebar' ? 'needs-you' : 'tasks');
    } else if (followed) setDetail(followed.id);
    else setTab('needs-you');
  };
  // Toggles the condensed view: the Runs and Usage screens have no pane in
  // it, so it opens on the tree from them.
  const toggleCondensed = () => {
    setZoom(false);
    setCondensed((condensed) => !condensed);
    if (!condensed && (tab === 'runs' || tab === 'usage')) show('tasks');
  };
  // A number key switches to its screen, leaving any detail behind.
  const show = (next: Tab) => {
    setTab(next);
    setDetail(null);
  };
  // Where the command line jumps: a task's detail, the tree under the cursor
  // on it, or the tree filtered by a group.
  const jump = (to: Jump) => {
    if ('refused' in to) return setRefusal(to.refused);
    setRefusal(null);
    if (to.to === 'group') return filterBy(to.group);
    if (to.to === 'gc') return setView({ kind: 'gc' });
    const { taskId } = to;
    // A task the group filter hides shows again in the whole tree.
    if (group !== null && !state?.tasks[taskId]?.groups.includes(group)) setGroup(null);
    setCursors((cursors) => ({ ...cursors, tasks: { row: taskId, index: Math.max(tree.findIndex(({ id }) => id === taskId), 0) } }));
    setTab('tasks');
    setDetail(taskId);
  };
  // Filters the task tree by a group, or by none, and shows it.
  const filterBy = (next: string | null) => {
    setGroup(next);
    show('tasks');
  };
  // The selected request's answer. The cursor stays where it is, so once the
  // request leaves Needs you the next item slides under it.
  const answers = useAnswering(connection, item, itemTask, {
    onSend: () => setCursors((cursors) => ({ ...cursors, 'needs-you': { row: null, index: at(cursors['needs-you'], rows) } })),
    onReply: ({ reply, taskId, opens }) => {
      setRefusal(reply.ok ? null : reply.reason);
      if (reply.ok && opens && taskId) setView({ kind: 'conversation', taskId });
    },
  });
  // Answers the selected task's request: Needs you, its cursor and the
  // digits on it.
  const answer = () => {
    const index = selected ? queue.findIndex((item) => item.taskId === selected.id) : -1;
    if (index < 0) return;
    setCursors((cursors) => ({ ...cursors, 'needs-you': { row: rowOf(queue[index]!), index } }));
    show('needs-you');
    setAnswering(true);
  };
  // Moves the selected task's next runs to the tier after its current one.
  const retier = () => {
    const task = selected;
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
  // Opens the task's conversation, reopening it first when no run is live.
  const openConversation = (taskId: string) => {
    if (reopens(state?.tasks[taskId])) sendThenOpen({ type: 'open', taskId });
    else setView({ kind: 'conversation', taskId });
  };
  // Hands the selected HITL task off from its conversation, where the
  // handoff sheet opens: a parked one first resumes to write the brief.
  const handOff = () => {
    const task = selected;
    if (task?.mode === 'HITL') sendThenOpen({ type: 'openHandoff', taskId: task.id });
  };
  // Converses with the selected task: a HITL one in its conversation, an AFK
  // one taken over into it.
  const converse = () => {
    const task = selected ?? itemTask;
    if (task?.mode === 'HITL') openConversation(task.id);
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
    const task = selected;
    if (!task || !finishable(task)) return;
    void connection.send({ type: 'finishLoop', taskId: task.id }).then((reply) => setRefusal(reply.ok ? null : reply.reason));
  };
  // Retries the selected task's failed run, as Needs you's Retry does: a
  // child's included, from the tree.
  const retry = () => {
    const task = selected;
    if (!task || !failedTask(state, task)) return;
    void connection.send({ type: 'answer', taskId: task.id }).then((reply) => setRefusal(reply.ok ? null : reply.reason));
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
  const height = useRows();
  useInput(
    (input, key) => {
      if (cancelSheet) {
        const picked = chooseKey(cancelSheet.options, input, key);
        if (picked) setCancelSheet(null);
        if (picked && picked !== 'back') cancel(picked.command);
        return;
      }
      if (help) {
        if (input === '?' || key.escape) setHelp(false);
        return;
      }
      if (draft.current !== null) {
        const line = draft.current;
        if (key.escape) setCommand(null);
        else if (key.return) {
          setCommand(null);
          if (state) jump(runCommand(line, state));
        } else setCommand(edit(line, input, key) ?? line);
        return;
      }
      if (pickerAt.current !== null) {
        const picked = pickerKey(groups.map(([name]) => name), pickerAt.current, input, key);
        if (picked === 'back') setPickerCursor(null);
        else if (picked && 'cursor' in picked) setPickerCursor(picked.cursor);
        else if (picked) {
          setPickerCursor(null);
          filterBy(picked.picked);
        }
        return;
      }
      if (answering && !item) setAnswering(false);
      else if (answering) {
        if (answers.form !== null || answers.confirm !== null) answers.key(input, key);
        else if (key.escape) setAnswering(false);
        else if (input === 'c') converse();
        else if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
        else if (key.return && opens) openConversation(opens);
        else answers.key(input, key);
        return;
      }
      if (item && (input === 'a' || (key.return && answerable(item, itemTask)))) return setAnswering(true);
      if (input === 'a') return answer();
      if (input === '?') return setHelp(true);
      if (input === 'g') return setPickerCursor(groups.findIndex(([name]) => name === group) + 1);
      if (input === ':') return setCommand('');
      if (input === 'v') return toggleCondensed();
      if (condensed && key.tab) return nextPane();
      if (condensed && input === 'f') return setZoom((zoom) => !zoom);
      if (condensed && zoom && key.escape) return setZoom(false);
      const screen = TABS[Number(input) - 1];
      if (screen) {
        setCondensed(false);
        setZoom(false);
        show(screen);
      }
      if (key.escape && drilled) setDetail(null);
      if (input === 'N' && state) setView({ kind: 'launch' });
      if (input === 'n' && !key.ctrl && state) setView({ kind: 'quick' });
      if (input === 'H' && tab === 'tasks' && !drilled) setHideFinished((hide) => !hide);
      if (key.upArrow && !drilled) move(-1);
      if (key.downArrow && !drilled) move(1);
      if (key.return && opens) openConversation(opens);
      if (key.return && drills) setDetail(drills);
      if (input === 't') retier();
      if (input === 'c') converse();
      const cancels = selected ?? itemTask;
      if (input === 'x' && cancels) cancel({ type: 'cancel', taskId: cancels.id });
      if (input === 'F') finishLoop();
      if (input === 'y') retry();
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
  // The keys the screen on show takes, and those of the selection's only when
  // they apply. While a sheet holds the keys, its own hint says what they do.
  const footer = (): Hint[] => {
    if (view.kind !== 'tabs' || pickerCursor !== null || cancelSheet || command !== null) return [];
    if (help) return [['?', 'or esc closes']];
    if (condensed) return [['tab', 'focus'], ['f', 'zoom'], ['g', 'group'], [':', 'command'], ['v', 'screens'], ['?', 'keys']];
    if (drilled) {
      const answers = queue.some((item) => item.taskId === drilled.id && answerable(item, drilled));
      return [['enter', 'open conversation'], ['c', 'converse or take over'], ...(answers ? [['a', 'answer'] as Hint] : []), ['x', 'cancel'], ['esc', 'back'], ['?', 'keys']];
    }
    if (tab === 'tasks') {
      return [
        ['enter', 'detail'],
        ['c', 'converse or take over'],
        ['t', 're-tier'],
        ['x', 'cancel'],
        ...(finishable(tasks[cursor]) ? [['F', 'finish after this ticket'] as Hint] : []),
        ...(failedTask(state, tasks[cursor]) ? [['y', 'retry'] as Hint] : []),
        ['g', 'group'],
        ['n', 'quick launch'],
        ['N', 'launch'],
        ['?', 'keys'],
      ];
    }
    if (tab === 'needs-you') return [['↑↓', 'move'], ['a', 'answer'], ['c', 'converse or take over'], ['x', 'cancel'], ['?', 'keys']];
    if (tab === 'runs') return [['enter', 'its task’s detail'], ['c', 'converse or take over'], ['x', 'cancel its task'], ['?', 'keys']];
    return [['1–4', 'screens'], ['?', 'keys']];
  };
  if (state && view.kind === 'conversation') {
    return h(Conversation, { connection, state, taskId: view.taskId, onLeave: toTabs });
  }

  return h(
    Box,
    { flexDirection: 'column', height, overflow: 'hidden' },
    // On a full screen only the screen's pane gives way: squeezed, wrapped
    // text would draw its lines over the next ones.
    fixed(
      h(Header, { key: 'header', tab: condensed ? null : tab, needsYou: state?.attentionQueue.length ?? 0 }),
      h(Rule, { key: 'header-rule' }),
      h(Breadcrumb, { key: 'crumb', screen: condensed ? 'Condensed' : TAB_NAMES[tab], task: condensed ? undefined : drilled, group: tab === 'tasks' || condensed ? (group ?? 'all') : null }),
      h(Rule, { key: 'crumb-rule' }),
      unregistered
        ? h(Text, { key: 'register' }, `${unregistered.repo} is not registered. `, h(Text, { bold: true }, 'r'), ' Register this repo')
        : null,
      missingSetup
        ? missingSetup.settingUp
          ? h(Text, { key: 'setup', ...tone('dim') }, `${missingSetup.repo} is being set up for the skill set in ${missingSetup.settingUp}.`)
          : h(
              Text,
              { key: 'setup', ...tone(missingSetup.offered ? 'warn' : 'dim') },
              `${missingSetup.reason} `,
              ...(missingSetup.offered ? [h(Text, { key: 's', bold: true }, 's'), ' Set up now · '] : []),
              h(Text, { key: 'R', bold: true }, 'R'),
              ' re-check',
            )
        : null,
      refusal ? h(Text, { key: 'refusal', ...tone('bad') }, refusal) : null,
      pickerCursor === null ? null : h(GroupPicker, { key: 'picker', groups, cursor: pickerCursor, current: group }),
      cancelSheet
        ? h(ChoosePrompt, { key: 'cancel', title: `Cancel ${cancelSheet.taskId}`, reason: cancelSheet.reason, options: cancelSheet.options.map(({ label }) => label) })
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
      view.kind === 'gc' ? h(GcSheet, { key: 'gc', connection, onLeave: toTabs }) : null,
    ),
    // The quick launch card gives way too, as its handoff sheet's brief
    // does, but only once the screen's pane has none left to give.
    state && view.kind === 'quick'
      ? h(
          Box,
          { flexDirection: 'column', flexShrink: 1, overflow: 'hidden' },
          h(QuickLaunch, {
            connection,
            state,
            here: clone?.repo ?? null,
            onExpand: (taskId: string) => setView({ kind: 'conversation', taskId }),
            onLeave: toTabs,
          }),
        )
      : null,
    h(
      Box,
      // Boxes give way in proportion to their weight times their height:
      // this one's outweighs the quick launch card's.
      { flexDirection: 'column', flexShrink: PANE_GIVES_WAY_FIRST, overflow: 'hidden' },
      state === null
        ? h(Text, tone('dim'), 'Attaching to the daemon…')
        : help
          ? fixed(h(Help))
        : condensed
          ? h(Condensed, {
              focus,
              zoom,
              group,
              sidebar: h(Sidebar, { state, cursor: at(cursors['needs-you'], queue.map(rowOf)), focused: focus === 'sidebar', groups, group }),
              tree: h(TaskList, { connection, state, tasks, hidden: hideFinished ? tree.length - tasks.length : null, cursor: at(cursors.tasks, tasks.map(({ id }) => id)), focused: focus === 'tree', compact: true }),
              detail: followed ? h(TaskDetail, { connection, state, task: followed }) : h(Text, tone('dim'), 'Nothing selected.'),
            })
        : drilled
          ? h(TaskDetail, { connection, state, task: drilled })
        : tab === 'tasks'
          ? h(TaskList, { connection, state, tasks, hidden: hideFinished ? tree.length - tasks.length : null, cursor })
          : tab === 'needs-you'
            ? h(NeedsYouList, { state, cursor })
            : tab === 'runs'
              ? h(RunsList, { state, runs, cursor })
              : fixed(h(UsageTab, { state })),
    ),
    fixed(
      state && item
        ? h(AnswerSheet, { item, task: itemTask, card: answers.card, answering, form: answers.form, confirm: answers.confirm, position: { at: cursor + 1, of: queue.length } })
        : null,
      closed ? h(Text, { ...tone('bad') }, 'The daemon connection closed.') : null,
      command === null ? null : h(CommandLine, { draft: command }),
      h(Rule, { key: 'strip-rule' }),
      state ? h(UsageStrip, { state }) : null,
      h(Rule, { key: 'footer-rule' }),
      h(Keys, { keys: footer() }),
    ),
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

// The factory's name, then the screens' tabs, the one on show filled, and
// Needs you lit while anything needs the operator. In the condensed view,
// which has no tabs, its name and Needs you's count.
function Header({ tab, needsYou }: { tab: Tab | null; needsYou: number }) {
  const label = (key: Tab, text: string) =>
    h(Text, { key, ...(tab === key ? { ...filled(), bold: true } : tone(key === 'needs-you' && needsYou > 0 ? 'warn' : 'dim')) }, ` ${text} `);
  return h(
    Box,
    { gap: 1 },
    h(Text, { ...tone('accent'), bold: true }, 'agents-factory'),
    ...(tab === null
      ? [h(Text, { key: 'condensed', ...tone('dim') }, ' Condensed '), h(Text, { key: 'needs-you', ...tone(needsYou > 0 ? 'warn' : 'dim') }, ` Needs you (${needsYou}) `)]
      : TABS.map((key, i) => label(key, `${i + 1} ${TAB_NAMES[key]}${key === 'needs-you' ? ` (${needsYou})` : ''}`))),
  );
}

// Where the operator is: the screen, then the task drilled into, or the
// group the task tree is filtered by.
function Breadcrumb({ screen, task, group }: { screen: string; task: TaskView | undefined; group: string | null }) {
  const rest = task ? ` ${GLYPH.crumb} ${task.id} ${task.title}` : group !== null ? ` ${GLYPH.between} group: ${group}` : '';
  return h(Text, { wrap: 'truncate' }, h(Text, tone('fg'), screen), h(Text, tone('dim'), rest));
}

// The task tree, Done and Cancelled tasks dimmed, and the selected task's
// output under it. `hidden` counts the finished tasks it hides, while it
// hides them.
function TaskList({
  connection,
  state,
  tasks,
  hidden,
  cursor,
  focused = true,
  compact = false,
}: {
  connection: FactoryConnection;
  state: FactoryState;
  tasks: TaskView[];
  hidden: number | null;
  cursor: number;
  // Whether the cursor shows: in the condensed view, only while the tree has the focus.
  focused?: boolean;
  // In the condensed view: the rows narrow, without the keys or the output,
  // which the detail beside it shows.
  compact?: boolean;
}) {
  const columns = useColumns();
  if (tasks.length === 0) return h(Text, tone('dim'), hidden ? `Every task is finished. H shows the ${hidden}.` : 'No tasks yet. n quick-launches one, N launches one.');
  const layout = rowLayout(tasks, columns, compact);
  const rows = tasks.map((task, i) => h(TaskRow, { key: task.id, task, selected: focused && i === cursor, layout }));
  if (compact) {
    return column([
      h(CursorWindow, { key: 'tree', cursor, items: rows }),
      hidden === null ? null : fixed(h(Text, { key: 'hidden', ...tone('dim') }, `${hidden} finished hidden · H shows them`)),
    ]);
  }
  return column([
    h(CursorWindow, { key: 'tree', cursor, items: rows }),
    fixed(
      hidden === null ? null : h(Text, { key: 'hidden', ...tone('dim') }, `${hidden} finished hidden · H shows them`),
      h(Output, { key: 'output', connection, state, taskId: tasks[cursor]!.id, lines: OUTPUT_PANE_LINES }),
    ),
  ]);
}

// The tasks as a tree: each root in order, its descendants under it, depth first.
function treeOrder(tasks: TaskView[]): TaskView[] {
  const ids = new Set(tasks.map(({ id }) => id));
  const ordered: TaskView[] = [];
  const place = (task: TaskView) => {
    ordered.push(task);
    for (const child of tasks) if (child.parent === task.id) place(child);
  };
  for (const task of tasks) if (!task.parent || !ids.has(task.parent)) place(task);
  return ordered;
}

function finished(task: TaskView): boolean {
  return task.state === 'done' || task.state === 'cancelled';
}

// The tree's tasks that `keep` keeps, and those above them, which keep the
// tree whole: without its finished tasks, say, or only a group's.
function keepingAncestors(tree: TaskView[], keep: (task: TaskView) => boolean): TaskView[] {
  const byId = new Map(tree.map((task) => [task.id, task]));
  const kept = new Set<string>();
  for (const task of tree) {
    if (!keep(task)) continue;
    for (let at: TaskView | undefined = task; at && !kept.has(at.id); at = at.parent ? byId.get(at.parent) : undefined) kept.add(at.id);
  }
  return tree.filter((task) => kept.has(task.id));
}

// The columns below which a task row gives up its groups, then its extras.
const GROUPS_COLUMNS = 100;
const EXTRAS_COLUMNS = 90;
// The widest mode and autonomy (`HITL`, `AFK L2`) and state label (`Waiting on children`).
const MODE_WIDTH = 6;
const STATE_WIDTH = 19;
// The narrowest a title gets for the extras to have room, and the widest the groups get.
const MIN_TITLE_WIDTH = 20;
const MAX_GROUPS_WIDTH = 24;

// Each column's width, the same on every row so the columns line up. The
// title takes what the others leave, all of it but what keeps the widest
// extras whole, and never less than its least. The condensed view's rows
// are `compact`: only the glyph, id, title and state, the title taking what
// the pane leaves.
type RowLayout = { compact: boolean; glyph: number; id: number; title: number; extras: number; groups: number };

function rowLayout(tasks: TaskView[], columns: number, compact: boolean): RowLayout {
  const widest = (texts: string[]) => Math.max(0, ...texts.map((text) => text.length));
  const glyph = Math.max(1, ...tasks.map(({ depth }) => depth * 2 + 1));
  const id = widest(tasks.map(({ id }) => id));
  if (compact) return { compact, glyph, id, title: 0, extras: 0, groups: 0 };
  // Narrower than the TUI is designed for, a row gives up its groups, then its extras.
  const groups = columns >= GROUPS_COLUMNS ? Math.min(widest(tasks.map((task) => task.groups.join(', '))), MAX_GROUPS_WIDTH) : 0;
  const extras = columns >= EXTRAS_COLUMNS ? widest(tasks.map(extrasOf)) : 0;
  // The cursor, glyph, id, title, mode and state, each with a gap after it but the last.
  const fixed = 1 + glyph + id + MODE_WIDTH + STATE_WIDTH + 5 + (groups ? groups + 1 : 0);
  const rest = Math.max(columns - fixed, 1);
  if (!extras || rest - 1 < MIN_TITLE_WIDTH + 4) return { compact, glyph, id, title: rest, extras: 0, groups };
  const title = Math.max(MIN_TITLE_WIDTH, rest - 1 - extras);
  return { compact, glyph, id, title, extras: rest - 1 - title, groups };
}

// What a row says past its state: its loop's ticket, its descendants'
// rollup and its progress.
function extrasOf(task: TaskView): string {
  return joined([loopDetail(task), rollupDetail(task), task.progress]);
}

// A task in the tree: its state's glyph, indented by its depth; its id and
// title; its mode and autonomy; its state, lit as its glyph is; its extras;
// and its groups. A finished task is dim, a cancelled one struck through
// too, and the selected one's title bold in fg, finished or not.
function TaskRow({ task, selected, layout }: { task: TaskView; selected: boolean; layout: RowLayout }) {
  const look = stateLook(task.label);
  const quiet = (text: string) => h(Text, { ...tone('dim'), wrap: 'truncate' }, text);
  const cell = (width: number | undefined, content: ReactNode, right = false) =>
    h(Box, { width, flexShrink: 0, justifyContent: right ? 'flex-end' : 'flex-start' }, content);
  // A finished task's title is dim, but the selected one's is bold fg as
  // every selected title is: the cursor lights it, struck through or not.
  const title = h(Text, { ...tone(finished(task) && !selected ? 'dim' : 'fg'), bold: selected, strikethrough: look.strike, wrap: 'truncate' }, task.title);
  const state = h(Text, { ...tone(look.role), wrap: 'truncate' }, task.label);
  const indent = '  '.repeat(task.depth);
  if (layout.compact) {
    return h(
      Box,
      { gap: 1 },
      h(Cursor, { on: selected }),
      cell(layout.glyph, h(Text, tone(look.role), `${indent}${look.glyph}`)),
      cell(layout.id, quiet(task.id)),
      h(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, title),
      cell(undefined, state),
    );
  }
  return h(
    Box,
    { gap: 1 },
    h(Cursor, { on: selected }),
    cell(layout.glyph, h(Text, tone(look.role), `${indent}${look.glyph}`)),
    cell(layout.id, quiet(task.id)),
    // On a terminal too narrow for the other columns, the title gives way first.
    h(Box, { width: layout.title, flexShrink: 1 }, title),
    cell(MODE_WIDTH, quiet(modeOf(task))),
    cell(STATE_WIDTH, state),
    layout.extras ? cell(layout.extras, quiet(extrasOf(task))) : null,
    layout.groups ? cell(layout.groups, quiet(task.groups.join(', ')), true) : null,
  );
}

// A tree row's rollup of its descendants (ADR 0009), and on a root the
// failures waiting on the operator below it.
function rollupDetail({ rollup, parent }: TaskView): string {
  if (!rollup) return '';
  const counts = (
    [
      [rollup.done, 'done', 'done'],
      [rollup.running, 'running', 'running'],
      [rollup.needsYou, 'needs you', 'need you'],
      [rollup.cancelled, 'cancelled', 'cancelled'],
    ] as const
  ).flatMap(([count, one, many]) => (count ? [`${count} ${count === 1 ? one : many}`] : []));
  const failed = !parent && rollup.failed.length ? ` · ${rollup.failed.map(({ taskId }) => `${taskId} failed`).join(', ')}` : '';
  return `[${counts.join(', ')}]${failed}`;
}

// Whether the task's run failed and waits on the operator's Retry.
function failedTask(state: FactoryState | null, task: TaskView | undefined): boolean {
  return !!task && !!state?.attentionQueue.some((item) => item.kind === 'attention' && item.taskId === task.id && item.attention === 'failure');
}

// Whether the task's Ralph loop can still be finished after its ticket.
function finishable(task: TaskView | undefined): boolean {
  return task?.mode === 'AFK' && !!task.loop && !task.loop.finishing;
}

// The ticket a task's loop works, and whether it ends after it.
function loopDetail({ loop }: TaskView): string {
  if (!loop) return '';
  if (!loop.ticket) return loop.finishing ? 'finishing' : '';
  return `on ${loop.ticket}${loop.finishing ? ', finishing after it' : ''}`;
}

// The widest Needs you kind (`repo missing`) and the title's width on a Needs you row.
const ITEM_KIND_WIDTH = 12;
const ITEM_TITLE_WIDTH = 30;

// Needs you, an item a row: its kind lit in its colour, its task's id and
// bright title, and what it asks, dim.
function NeedsYouList({ state, cursor }: { state: FactoryState; cursor: number }) {
  if (state.attentionQueue.length === 0) return h(Text, tone('dim'), 'Nothing needs you.');
  const id = Math.max(2, ...state.attentionQueue.map(({ taskId }) => (taskId ?? '').length));
  return h(CursorWindow, {
    cursor,
    items: state.attentionQueue.map((item, i) => {
      const key = item.kind === 'attention' ? item.requestId : `${item.kind}-${item.taskId}`;
      const task = item.taskId === null ? undefined : state.tasks[item.taskId];
      const look = kindLook(item);
      return h(
        Box,
        { key, gap: 1 },
        h(Cursor, { on: i === cursor }),
        h(Box, { width: ITEM_KIND_WIDTH, flexShrink: 0 }, h(Text, { ...tone(look.role), wrap: 'truncate' }, look.kind)),
        h(Box, { width: id, flexShrink: 0 }, h(Text, tone('dim'), item.taskId ?? '')),
        h(Box, { width: ITEM_TITLE_WIDTH, flexShrink: 0 }, h(Text, { ...tone('fg'), bold: i === cursor, wrap: 'truncate' }, titleOf(item, task))),
        h(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, h(Text, { ...tone('dim'), wrap: 'truncate' }, askedFor(item, task))),
      );
    }),
  });
}

function column(children: ReactNode[]) {
  return h(Box, { flexDirection: 'column' }, ...children);
}
