// The question card: what the agent asked through `AskUserQuestion`, answered
// in the conversation view one question at a time. A digit picks an option
// (toggles it on a multi-select, which enter confirms), and typed text
// answers in the operator's own words.
import { createElement as h } from 'react';
import { Box, Text, type Key } from 'ink';
import type { Answers, Question } from '../lifecycle/lifecycle.ts';
import { GLYPH, Option, Sheet, tone } from './theme.ts';

export type Card = {
  // The question being answered.
  index: number;
  answers: Answers;
  // The options toggled on a multi-select, by index.
  picked: number[];
};

export const newCard = (): Card => ({ index: 0, answers: {}, picked: [] });

export type CardKey =
  // The key isn't the card's: it edits the draft as usual.
  | { kind: 'ignored' }
  | { kind: 'card'; card: Card; clearDraft: boolean }
  // Every question has its answer.
  | { kind: 'answered'; answers: Answers };

export function cardKey(question: Question, card: Card, draft: string, input: string, key: Key): CardKey {
  const asked = question.questions[card.index]!;
  const answer = (text: string): CardKey => {
    const answers = { ...card.answers, [asked.question]: text };
    if (card.index + 1 === question.questions.length) return { kind: 'answered', answers };
    return { kind: 'card', card: { index: card.index + 1, answers, picked: [] }, clearDraft: true };
  };
  if (key.return) {
    if (draft.trim()) return answer(draft.trim());
    if (asked.multiSelect && card.picked.length) {
      return answer([...card.picked].sort((a, b) => a - b).map((i) => asked.options[i]!.label).join(', '));
    }
    return { kind: 'card', card, clearDraft: false };
  }
  const option = /^[1-9]$/.test(input) && !draft ? Number(input) - 1 : -1;
  if (!asked.options[option]) return { kind: 'ignored' };
  if (!asked.multiSelect) return answer(asked.options[option].label);
  const picked = card.picked.includes(option) ? card.picked.filter((i) => i !== option) : [...card.picked, option];
  return { kind: 'card', card: { ...card, picked }, clearDraft: false };
}

// `ownWords` says whether typed text can answer too: not on an answer sheet.
// `nested` in a sheet of its own (an answer sheet, quick launch), the card
// is that sheet's; alone, as in a conversation, it is a sheet itself.
export function QuestionCard({ question, card, ownWords = true, nested = false }: { question: Question; card: Card; ownWords?: boolean; nested?: boolean }) {
  const asked = question.questions[card.index]!;
  const count = question.questions.length;
  const hint = `${asked.multiSelect ? 'digits toggle · enter confirm' : 'digit picks'}${ownWords ? ' · or type your own answer' : ''}`;
  const body = [
    h(
      Box,
      { key: 'asked', gap: 1 },
      h(Text, { inverse: true, bold: true }, ` ${asked.header} `),
      h(Text, { ...tone('fg'), bold: true }, asked.question),
      count > 1 ? h(Text, tone('dim'), `(${card.index + 1}/${count})`) : null,
    ),
    ...asked.options.map((option, i) =>
      h(
        Option,
        { key: option.label, digit: i + 1 },
        h(
          Box,
          { gap: 1 },
          asked.multiSelect ? h(Text, tone(card.picked.includes(i) ? 'ok' : 'dim'), card.picked.includes(i) ? GLYPH.ticked : GLYPH.unticked) : null,
          h(Text, null, option.label),
          h(Text, tone('dim'), option.description),
        ),
      ),
    ),
  ];
  if (!nested) return h(Sheet, { title: 'Question', hint }, ...body);
  return h(Box, { flexDirection: 'column', flexShrink: 0 }, ...body, h(Text, { key: 'hint', ...tone('dim') }, hint));
}
