// The handoff sheet (`ctrl+h` or `/handoff` in a conversation): open while
// the task's handoff is, so it is back on reattach. The HITL run writes the
// brief; the operator edits it line by line, sets continue-as, autonomy
// level, tier and max turns, and confirms. Esc backs out and the conversation carries on.
import { createElement as h, useReducer, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { AUTONOMY_LEVELS, CONTINUE_AS, type AutonomyLevel, type Brief, type ContinueAs } from '../lifecycle/lifecycle.ts';
import { TIERS, type Tier } from '../models/routing.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { HandoffView, RunView, TaskView } from '../protocol/factory-state.ts';
import { autonomyText, cycle } from './launch-card.ts';
import { CursorWindow, fixed } from './screen.ts';
import { edit, withCaret, type Caret } from './text-input.ts';
import { choosable, Cursor, GLYPH, Sheet, tone } from './theme.ts';

type Props = {
  connection: FactoryConnection;
  task: TaskView & { handoff: HandoffView };
  // The task's live run, if any: it writes the brief.
  run: RunView | undefined;
};

type List = 'decided' | 'doneWhen' | 'outOfScope' | 'links';
const LISTS: [List, string][] = [
  ['decided', 'Decided'],
  ['doneWhen', 'Done when'],
  ['outOfScope', 'Out of scope'],
  ['links', 'Links'],
];
// A line of the sheet: the goal, an item of a list (one past its last adds
// one), or a field.
type Line = { kind: 'goal' } | { kind: 'item'; list: List; index: number } | { kind: 'field'; field: 'continueAs' | 'autonomy' | 'tier' | 'maxTurns' };
const LABEL_WIDTH = 14;

// What the operator has made of the sheet so far, and the caret in the line
// being typed into, back at its end on another line.
type Draft = { brief: Brief | null; continueAs: ContinueAs; autonomy: AutonomyLevel; tier: Tier; maxTurns: string; line: number; caret: Caret };

export function HandoffSheet({ connection, task, run }: Props) {
  const { handoff } = task;
  // Keys typed in one burst arrive before a re-render, so the draft is kept here.
  const draft = useRef<Draft>({ brief: null, continueAs: handoff.continueAs, autonomy: handoff.autonomy, tier: handoff.tier, maxTurns: String(handoff.maxTurns), line: 0, caret: null });
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The brief is the operator's to edit once the agent has written it.
  if (handoff.brief && !draft.current.brief) draft.current.brief = structuredClone(handoff.brief);
  const { brief } = draft.current;
  const lines = linesOf(brief);
  const writing = !brief && run?.status === 'active' && run.turn === 'agent';

  const send = (command: Parameters<FactoryConnection['send']>[0]) =>
    void connection.send(command).then((reply) => setRefusal(reply.ok ? null : reply.reason));

  useInput((input, key) => {
    const current = draft.current;
    if (key.escape) return send({ type: 'closeHandoff', taskId: task.id });
    if (key.return) {
      if (!current.brief) {
        // The agent ended its turn without the brief: ask it again.
        if (!writing) send({ type: 'openHandoff', taskId: task.id });
        return;
      }
      const { continueAs, autonomy, tier, maxTurns } = current;
      return send({ type: 'handoff', taskId: task.id, brief: current.brief, continueAs, autonomy, tier, maxTurns: Number(maxTurns) });
    }
    if (key.upArrow || key.downArrow) {
      const line = Math.min(Math.max(current.line + (key.upArrow ? -1 : 1), 0), lines.length - 1);
      if (line !== current.line) Object.assign(current, { line, caret: null });
    } else {
      step(current, lines[current.line]!, input, key);
    }
    rerender();
  });

  const at = lines[draft.current.line];
  const to = handoff.stage ? `to ${handoff.stage} (AFK)` : 'to one AFK run on the brief';
  const share = handoff.contextShare === null ? null : `the conversation fills ${Math.round(handoff.contextShare * 100)}% of the context window`;
  const { blockers, toCommit } = handoff.readiness;
  // The brief's lines, before the fields: on a field, the brief shows its end.
  const briefLines = lines.filter((line) => line.kind !== 'field');
  return h(
    Sheet,
    { title: `Hand off ${task.id} ${to}`, hint: `${brief ? 'enter hand off · ↑↓ line · type to edit · ←→ change' : 'enter ask again'} · esc keep talking`, shrinks: true },
    // On a short screen only the brief gives way, scrolled to keep the
    // selected line in view: the fields and what blocks the handoff stay.
    brief
      ? h(CursorWindow, {
          cursor: Math.min(draft.current.line, briefLines.length - 1),
          items: briefLines.map((line, i) => h(BriefLine, { key: i, line, brief, caret: i === draft.current.line ? draft.current.caret : undefined, first: startsSection(lines, i) })),
        })
      : fixed(h(Text, tone('warn'), writing ? 'The agent is writing the brief…' : 'The agent ended its turn without writing the brief: enter asks again.')),
    fixed(
      h(Field, { key: 'continueAs', label: 'Continue as', selected: at?.kind === 'field' && at.field === 'continueAs' }, choosable(draft.current.continueAs), share && h(Text, tone('dim'), ` ${share}`)),
      h(Field, { key: 'autonomy', label: 'Autonomy', selected: at?.kind === 'field' && at.field === 'autonomy' }, choosable(autonomyText(draft.current.autonomy))),
      h(Field, { key: 'tier', label: 'Tier', selected: at?.kind === 'field' && at.field === 'tier' }, choosable(draft.current.tier)),
      h(Field, { key: 'maxTurns', label: 'Max turns', selected: at?.kind === 'field' && at.field === 'maxTurns' }, at?.kind === 'field' && at.field === 'maxTurns' ? withCaret(draft.current.maxTurns, draft.current.caret) : draft.current.maxTurns || ' '),
      h(Text, { key: 'commit', ...tone('dim') }, toCommit.length ? `The handoff commit takes ${toCommit.join(', ')}.` : 'Nothing to commit.'),
      ...blockers.map((blocker, i) => h(Text, { key: `blocker-${i}`, ...tone('bad') }, `${GLYPH.failed} ${blocker}`)),
      refusal ? h(Text, { key: 'refusal', ...tone('bad') }, refusal) : null,
    ),
  );
}

// The goal, each list's items with a line to add one, then the fields.
function linesOf(brief: Brief | null): Line[] {
  const fields: Line[] = [
    { kind: 'field', field: 'continueAs' },
    { kind: 'field', field: 'autonomy' },
    { kind: 'field', field: 'tier' },
    { kind: 'field', field: 'maxTurns' },
  ];
  if (!brief) return fields;
  const items = LISTS.flatMap(([list]): Line[] => Array.from({ length: brief[list].length + 1 }, (_, index) => ({ kind: 'item', list, index })));
  return [{ kind: 'goal' }, ...items, ...fields];
}

// Whether the line starts its section, so it carries the section's label.
function startsSection(lines: Line[], i: number): boolean {
  const line = lines[i]!;
  return line.kind !== 'item' || line.index === 0;
}

// The draft after a key on `line` that isn't enter, esc or ↑↓.
function step(draft: Draft, line: Line, input: string, key: Key): void {
  // The line's text after the key, its caret moved with it, or null when the key doesn't type.
  const type = (text: string, typed = input): string | null => {
    const edited = edit(text, draft.caret, typed, key);
    if (edited) draft.caret = edited.caret;
    return edited?.text ?? null;
  };
  if (line.kind === 'field') {
    const by = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
    if (line.field === 'continueAs' && by) draft.continueAs = cycle(CONTINUE_AS, draft.continueAs, by);
    if (line.field === 'autonomy' && by) draft.autonomy = cycle(AUTONOMY_LEVELS, draft.autonomy, by);
    if (line.field === 'tier' && by) draft.tier = cycle(TIERS, draft.tier, by);
    // A whole number: other characters are dropped.
    if (line.field === 'maxTurns') draft.maxTurns = type(draft.maxTurns, key.meta ? input : input.replace(/\D/g, '')) ?? draft.maxTurns;
    return;
  }
  const brief = draft.brief!;
  if (line.kind === 'goal') {
    brief.goal = type(brief.goal) ?? brief.goal;
    return;
  }
  const items = brief[line.list];
  const edited = type(items[line.index] ?? '');
  // Typing on the line past the last item adds one.
  if (edited !== null && (line.index < items.length || edited)) items[line.index] = edited;
}

// `caret` on the selected line, which shows it; undefined on the others.
function BriefLine({ line, brief, caret, first }: { line: Line; brief: Brief; caret: Caret | undefined; first: boolean }) {
  const selected = caret !== undefined;
  if (line.kind === 'field') return null;
  const label = line.kind === 'goal' ? 'Goal' : first ? LISTS.find(([list]) => list === line.list)![1] : '';
  const text = line.kind === 'goal' ? brief.goal : brief[line.list][line.index];
  return h(
    Box,
    { gap: 1 },
    h(Cursor, { on: selected }),
    h(Box, { width: LABEL_WIDTH, flexShrink: 0 }, h(Text, tone('dim'), label)),
    text === undefined ? h(Text, tone('dim'), selected ? '+ type to add' : '+') : h(Text, null, `${line.kind === 'goal' ? '' : '- '}${selected ? withCaret(text, caret) : text}`),
  );
}

function Field({ label, selected, children }: { label: string; selected: boolean; children?: ReactNode }) {
  return h(
    Box,
    { gap: 1 },
    h(Cursor, { on: selected }),
    h(Box, { width: LABEL_WIDTH, flexShrink: 0 }, h(Text, tone('dim'), label)),
    h(Text, null, children),
  );
}
