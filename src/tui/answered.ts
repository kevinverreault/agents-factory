// What the operator answered, as the TUI says it back: the line Needs you
// shows once an answer goes through, and the answers a task's conversation
// shows where they were given. The session file holds the agent's question
// but not the operator's answer as a message, so the TUI keeps a log of the
// answers given in this session, by task, whichever view they were given in
// and whichever run of the task the conversation shows.
import { useRef, useState } from 'react';
import type { ConversationEvent } from '../executor/executor.ts';
import type { Answers, AttentionQueueItem } from '../lifecycle/lifecycle.ts';
import { GLYPH } from './theme.ts';

// A question with the operator's answer to it.
export function answerOf(question: string, answer: string): string {
  return `${question} ${GLYPH.answers} ${answer}`;
}

// A card's answers on one line: each question, then its answer.
export function answersText(answers: Answers): string {
  return Object.entries(answers)
    .map(([question, answer]) => answerOf(question, answer))
    .join(` ${GLYPH.between} `);
}

// An answer the daemon asked about first, with the option it went ahead with.
export function withOption(answer: string, option: string): string {
  return `${answer}, ${option}`;
}

// The line that tells the operator their answer went through, and what it
// was: with the item's title where it isn't already the screen's.
export function answeredLine(answer: string, title?: string): string {
  return `${GLYPH.answered} Answered ${title === undefined ? '' : `${title}: `}${answer}`;
}

// The agent's tool call an item answers, if it answers one: a question's
// `AskUserQuestion`, or the call a permission request asks about.
export function toolUseOf(item: AttentionQueueItem): string | null {
  return item.kind === 'attention' ? (item.question?.id ?? item.permission?.id ?? null) : null;
}

// One answer, for its task's conversation. `runId` is the run the
// conversation showed when it was given; `toolUseId` the agent's call it
// answers, if any; `after` the last event the operator had seen, given in
// the conversation; `line` what the conversation says of it.
export type GivenAnswer = { id: string; taskId: string; runId: string | null; toolUseId: string | null; after: string | null; line: string };

// A conversation's events with the task's answers among them. An answer
// follows the call it answers, or else the event the operator last saw. With
// neither in the run shown, it is the latest of that run, or, given on an
// earlier run whose events the run shown doesn't replay, before them all.
export type Placed = { event: ConversationEvent } | { answer: GivenAnswer };
export function placed(events: ConversationEvent[], answers: GivenAnswer[], runId: string | null): Placed[] {
  const first: GivenAnswer[] = [];
  const last: GivenAnswer[] = [];
  const following = new Map<string, GivenAnswer[]>();
  for (const answer of answers) {
    const anchor =
      events.find((event) => answer.toolUseId !== null && event.type === 'toolUse' && event.toolUseId === answer.toolUseId) ??
      events.find((event) => event.id === answer.after);
    if (anchor) following.set(anchor.id, [...(following.get(anchor.id) ?? []), answer]);
    else (answer.runId === runId ? last : first).push(answer);
  }
  const of = (list: GivenAnswer[]): Placed[] => list.map((answer) => ({ answer }));
  return [...of(first), ...events.flatMap((event): Placed[] => [{ event }, ...of(following.get(event.id) ?? [])]), ...of(last)];
}

// The session's log of answers: `add` keeps one and returns its id, which
// `remove` takes back when the daemon refuses it.
export type AnswerLog = {
  of(taskId: string): GivenAnswer[];
  add(answer: Omit<GivenAnswer, 'id'>): string;
  remove(id: string): void;
};
export function useAnswerLog(): AnswerLog {
  const [answers, setAnswers] = useState<GivenAnswer[]>([]);
  const added = useRef(0);
  return {
    of: (taskId) => answers.filter((answer) => answer.taskId === taskId),
    add: (answer) => {
      const id = `answer-${(added.current += 1)}`;
      setAnswers((answers) => [...answers, { ...answer, id }]);
      return id;
    },
    remove: (id) => setAnswers((answers) => answers.filter((answer) => answer.id !== id)),
  };
}
