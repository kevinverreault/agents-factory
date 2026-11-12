// The quick launch overlay (`n`): one prompt launches the `quick` preset's
// grill, whose questions (at most three) show on a small card over the
// screens, answered with digits or in the operator's own words. The daemon
// opens the handoff sheet once the grill is done, at L1 by default; `ctrl+h`
// (or `/handoff`) opens it at any question, and `ctrl+e` expands the card into
// the full conversation on the same session. Esc leaves the grill to carry
// on as an ordinary conversation.
import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { Reply } from '../protocol/protocol.ts';
import { HandoffSheet } from './handoff-sheet.ts';
import { cycle, defaultRepo, NO_REPOSITORY } from './launch-card.ts';
import { Output } from './output.ts';
import { cardKey, newCard, QuestionCard, type Card } from './question-card.ts';
import { edit } from './text-input.ts';
import { choosable, GLYPH, Sheet, tone } from './theme.ts';
import { useLaunch } from './use-launch.ts';

// The preset a quick launch runs.
const QUICK_PRESET = 'quick';
// How many of the grill's latest events the card glances at.
const OUTPUT_LINES = 3;

type Props = {
  connection: FactoryConnection;
  state: FactoryState;
  // The repository holding the TUI's working directory, if any.
  here: string | null;
  // The grill goes on in the full conversation view.
  onExpand(taskId: string): void;
  onLeave(): void;
};

export function QuickLaunch({ connection, state, here, onExpand, onLeave }: Props) {
  const repositories = Object.keys(state.repositories);
  const [repo, setRepo] = useState(() => defaultRepo(state, here));
  const [taskId, setTaskId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // While the daemon names and launches the task. Left meanwhile, the grill
  // it launches goes on as an ordinary conversation, as after any esc.
  const launching = useLaunch(connection);
  // Keys typed in one burst arrive before a re-render, so what they edit is
  // kept here: the prompt, then a typed answer, and the card it answers.
  const typing = useRef<{ draft: string; card: Card; cardFor: string | null; answered: string | null }>({ draft: '', card: newCard(), cardFor: null, answered: null });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  const tell = (reply: Reply) => setRefusal(reply.ok ? null : reply.reason);

  const task = taskId ? state.tasks[taskId] : undefined;
  const run = task?.liveRunId ? state.runs[task.liveRunId] : undefined;
  const sheet = task?.handoff ?? null;
  // Handed off, the task carries on AFK, and a finished one is gone; past
  // its quick grill with no sheet open (expanded, or backed out of the
  // sheet), the conversation carries on.
  const over = task?.mode === 'AFK' || task?.state === 'done' || task?.state === 'cancelled';
  const expanded = !!task && !over && !task.quick && !sheet;
  useEffect(() => {
    if (over) onLeave();
    else if (expanded) onExpand(task.id);
  }, [over, expanded]);

  const question = run?.status === 'active' && run.question && run.question.id !== typing.current.answered ? run.question : null;
  const card = question && typing.current.cardFor === question.id ? typing.current.card : newCard();

  const launch = () => {
    const prompt = typing.current.draft.trim();
    if (!repo || !prompt) return;
    setRefusal(null);
    launching.launch({ type: 'launchTask', repo, preset: QUICK_PRESET, prompt, quick: true }, (launched) => {
      if (launched.ok && launched.left) return void connection.send({ type: 'expandQuickLaunch', taskId: launched.taskId });
      if (!launched.ok) return setRefusal(launched.reason);
      typing.current.draft = '';
      setTaskId(launched.taskId);
    });
  };
  const handOff = (id: string) => void connection.send({ type: 'openHandoff', taskId: id }).then(tell);
  const expand = (id: string) =>
    void connection.send({ type: 'expandQuickLaunch', taskId: id }).then((reply) => {
      tell(reply);
      if (reply.ok) onExpand(id);
    });

  useInput((input, key) => {
    const typed = typing.current;
    // The handoff sheet takes every key while it is open. This input stays
    // active meanwhile: turning it off would drop raw mode under the sheet.
    if (sheet) return;
    if (key.escape) {
      // A launched grill goes on as an ordinary conversation, opening no sheet itself.
      if (taskId) void connection.send({ type: 'expandQuickLaunch', taskId });
      launching.leave();
      return onLeave();
    }
    if (!task) {
      // The launch under way takes no other key.
      if (taskId || launching.busy()) return;
      if (key.return) return launch();
      if (key.leftArrow || key.rightArrow) return setRepo((repo) => cycle(repositories, repo, key.leftArrow ? -1 : 1));
      typed.draft = edit(typed.draft, input, key) ?? typed.draft;
      return rerender();
    }
    if (key.ctrl && input === 'e') return expand(task.id);
    if ((key.ctrl && input === 'h') || (key.return && typed.draft.trim() === '/handoff')) {
      typed.draft = '';
      rerender();
      return handOff(task.id);
    }
    // With no card up, what is typed waits for the next one, or is `/handoff`.
    if (!question) {
      typed.draft = edit(typed.draft, input, key) ?? typed.draft;
      return rerender();
    }
    if (typed.cardFor !== question.id) Object.assign(typed, { card: newCard(), cardFor: question.id });
    const onCard = cardKey(question, typed.card, typed.draft, input, key);
    if (onCard.kind === 'answered') {
      const answered = question.id;
      void connection.send({ type: 'answerQuestion', taskId: task.id, questionId: answered, answers: onCard.answers }).then((reply) => {
        tell(reply);
        // A refused answer leaves the card up, so the operator sees what is still open.
        if (!reply.ok && typed.answered === answered) Object.assign(typed, { answered: null, card: newCard() });
        rerender();
      });
      Object.assign(typed, { answered, draft: '' });
    } else if (onCard.kind === 'card') {
      typed.card = onCard.card;
      if (onCard.clearDraft) typed.draft = '';
    } else {
      typed.draft = edit(typed.draft, input, key) ?? typed.draft;
    }
    rerender();
  });

  const { draft } = typing.current;
  if (task && sheet) return h(HandoffSheet, { connection, task: { ...task, handoff: sheet }, run });
  if (!task) {
    return h(
      Sheet,
      { title: 'Quick launch', hint: `enter launch, at most three questions${repositories.length > 1 ? ' · ←→ repository' : ''} · esc back` },
      repo
        ? h(Box, { gap: 1 }, h(Text, tone('dim'), 'Repository'), h(Text, null, repositories.length > 1 ? choosable(repo) : repo))
        : h(Text, tone('warn'), NO_REPOSITORY),
      h(Text, null, h(Text, tone('ok'), `${GLYPH.operator} `), `${draft}${GLYPH.caret}`),
      launching.indicator ?? (taskId ? h(Text, tone('dim'), 'Starting the grill…') : null),
      refusal ? h(Text, tone('bad'), refusal) : null,
    );
  }
  return h(
    Sheet,
    { title: `Quick launch ${task.id}`, hint: 'ctrl+h or /handoff hand off · ctrl+e full conversation · esc leave it as a conversation' },
    h(Text, { ...tone('fg'), bold: true, wrap: 'truncate' }, task.title),
    question ? h(QuestionCard, { question, card, nested: true }) : h(Output, { connection, state, taskId: task.id, lines: OUTPUT_LINES }),
    h(Text, null, h(Text, tone('ok'), `${GLYPH.operator} `), `${draft}${GLYPH.caret}`),
    refusal ? h(Text, tone('bad'), refusal) : null,
  );
}
