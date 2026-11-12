// The README's media, each a scene played on the demo factory: a GIF of
// what the operator does, or the stills of the screens as they stand. A
// scene is only keys and text, paced for a reader to follow: the demo's
// connection answers them as the daemon would. The headless recorder
// (record.ts) and vhs (tapes.ts) both play these steps.
import { CTRL_B, CTRL_N, DOWN, ENTER, ESC, type Scene } from './stage.ts';

// A typist's pace, ms a key.
const TYPING = 90;
// The tree lists the newest task first: T9 to T5, then T2 with its
// children T4 and T3, then T1.
const TO_T2 = [DOWN, DOWN, DOWN, DOWN, DOWN];
const T2_TO_T1 = [DOWN, DOWN, DOWN];
const COLUMNS = 120;
const ROWS = 34;

const tasksAndLaunch: Scene = {
  name: 'tasks-and-launch',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    // Down the task tree: the output pane follows the selected task's run.
    { press: TO_T2 },
    { hold: 1_300 },
    // Quick launch: one prompt, and the agent's first question on its card.
    { press: ['n'] },
    { text: 'Add a --dry-run flag to sync.', pace: TYPING },
    { hold: 500 },
    { press: [ENTER] },
    { hold: 2_300 },
    { press: ['1'] },
    { hold: 2_300 },
  ],
};

const needsYou: Scene = {
  name: 'needs-you',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { press: ['2'] },
    { hold: 1_800 },
    // a takes the digits: 1 answers the question, and the next item slides up.
    { press: ['a'] },
    { press: ['1'] },
    { hold: 1_300 },
    { press: [DOWN] },
    { hold: 1_800 },
  ],
};

const taskDetail: Scene = {
  name: 'task-detail',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    // An AFK task's detail, then back to the tree.
    { press: TO_T2 },
    { press: [ENTER] },
    { hold: 2_300 },
    { press: [ESC] },
    // A HITL task's detail, then its conversation, and a reply.
    { press: T2_TO_T1 },
    { press: [ENTER] },
    { press: [ENTER] },
    { hold: 1_300 },
    { text: 'Only 5xx and timeouts. Never 4xx.', pace: TYPING },
    { hold: 500 },
    { press: [ENTER] },
    { hold: 2_800 },
  ],
};

const handoff: Scene = {
  name: 'handoff',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    // T1's detail by the command line, then its conversation.
    { press: [':'] },
    { text: 'task 1', pace: TYPING },
    { press: [ENTER, ENTER] },
    // The reply settles it: the agent proposes advancing.
    { text: 'Five attempts, with backoff.', pace: TYPING },
    { press: [ENTER] },
    { hold: 1_300 },
    { press: [CTRL_N] },
    { hold: 2_300 },
    // Straight on to the handoff instead, and its brief.
    { press: [ESC] },
    { text: '/handoff', pace: TYPING },
    { press: [ENTER] },
    { hold: 4_300 },
    { press: [ENTER] },
    { press: [CTRL_B] },
    { hold: 2_300 },
  ],
};

// The stills: each screen as it stands, taller so Usage shows whole.
const screens: Scene = {
  name: 'screens',
  columns: COLUMNS,
  rows: 44,
  steps: [
    { still: 'tasks' },
    { press: ['2'] },
    { still: 'needs-you' },
    { press: ['3'] },
    { still: 'runs' },
    { press: ['4'] },
    { still: 'usage' },
    { press: ['1', 'v'] },
    { still: 'condensed' },
  ],
};

export const GIFS: Scene[] = [tasksAndLaunch, needsYou, taskDetail, handoff];
export const STILLS: Scene[] = [screens];
