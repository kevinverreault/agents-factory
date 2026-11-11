// The README's media, each a scene played on the demo factory: a GIF of
// what the operator does, or the stills of the screens as they stand.
import type { RunView, TaskView } from '../protocol/factory-state.ts';
import { CONVERSING, demoState, GRILLING } from './demo-factory.ts';
import type { Scene } from './stage.ts';

const [UP, DOWN, ENTER, ESC, CTRL_N, CTRL_B] = ['\x1b[A', '\x1b[B', '\r', '\x1b', '\x0e', '\x02'];
// A typist's pace, ms a key.
const TYPING = 45;
const COLUMNS = 120;
const ROWS = 34;

const seeded = demoState();
const T5 = seeded.tasks.T5!;
const R5 = seeded.runs.R5!;

// The quick launch: one prompt, grilled on its own card.
const QUICK_PROMPT = 'Add a --dry-run flag to sync.';
const quickTask: TaskView = {
  ...CONVERSING,
  id: 'T10',
  title: QUICK_PROMPT,
  liveRunId: 'R10',
  branch: 'factory/T10-add-a-dry-run-flag-to-sync',
  worktree: '/worktrees/acme-widgets/T10',
  preset: null,
  groups: [],
  quick: { questions: 0, done: false },
};
const quickRun: RunView = {
  ...GRILLING,
  id: 'R10',
  taskId: 'T10',
  turn: 'agent',
  usage: {},
  question: {
    id: 'toolu_10',
    questions: [
      {
        question: 'Should --dry-run print the changes it would make?',
        header: 'Output',
        options: [
          { label: 'Yes, as a diff', description: 'One line per file, + and -' },
          { label: 'Only a count', description: '“12 files would change”' },
        ],
        multiSelect: false,
      },
    ],
  },
};

const tasksAndLaunch: Scene = {
  name: 'tasks-and-launch',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { hold: 1200 },
    { keys: [DOWN] },
    { hold: 1800 },
    { keys: ['n'] },
    { type: QUICK_PROMPT, pace: TYPING },
    { hold: 400 },
    { keys: [ENTER] },
    {
      patch: [
        { op: 'set', path: ['tasks', 'T10'], value: quickTask },
        { op: 'set', path: ['runs', 'R10'], value: quickRun },
      ],
    },
    { hold: 2200 },
    { keys: ['1'] },
    { patch: [{ op: 'set', path: ['runs', 'R10'], value: { ...quickRun, question: null } }] },
    { converse: 'R10', events: [{ type: 'toolUse', id: 'E1', tool: 'Read', summary: 'src/sync/command.ts' }] },
    { converse: 'R10', events: [{ type: 'message', id: 'E2', from: 'agent', text: 'A diff it is. Should --dry-run exit non-zero when something would change?' }] },
    { hold: 2200 },
  ],
};

const needsYou: Scene = {
  name: 'needs-you',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { keys: ['2'] },
    { hold: 1400 },
    { keys: ['a'] },
    { hold: 600 },
    { keys: ['1'] },
    {
      patch: [
        { op: 'set', path: ['attentionQueue'], value: seeded.attentionQueue.slice(1) },
        { op: 'set', path: ['tasks', 'T5'], value: { ...T5, state: 'running', label: 'Running' } },
        { op: 'set', path: ['runs', 'R5'], value: { ...R5, question: null } },
      ],
    },
    { hold: 2000 },
    { keys: [DOWN] },
    { hold: 2000 },
  ],
};

const taskDetail: Scene = {
  name: 'task-detail',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { hold: 600 },
    { keys: [DOWN] },
    { keys: [ENTER] },
    { hold: 2400 },
    { keys: [ESC] },
    { keys: [UP] },
    { keys: [ENTER] },
    { hold: 1000 },
    { keys: [ENTER] },
    { hold: 1400 },
    { type: 'Only 5xx and timeouts. Never 4xx.', pace: TYPING },
    { hold: 300 },
    { keys: [ENTER] },
    {
      patch: [{ op: 'set', path: ['runs', 'R1'], value: { ...GRILLING, turn: 'agent' } }],
    },
    { converse: 'R1', events: [{ type: 'message', id: 'E5', from: 'operator', text: 'Only 5xx and timeouts. Never 4xx.' }] },
    { converse: 'R1', events: [{ type: 'toolUse', id: 'E6', tool: 'Read', summary: 'src/webhooks/queue.ts' }] },
    {
      converse: 'R1',
      events: [{ type: 'message', id: 'E7', from: 'agent', text: 'Settled: 5xx and timeouts retry, 4xx never. How many attempts before a delivery is dead-lettered?' }],
    },
    { patch: [{ op: 'set', path: ['runs', 'R1'], value: GRILLING }] },
    { hold: 2500 },
  ],
};

const BRIEF = {
  goal: 'Failed webhook deliveries are retried with backoff, then dead-lettered.',
  decided: ['Retry 5xx and timeouts only, never 4xx.', 'Five attempts, exponential backoff from 30 s.'],
  doneWhen: ['A delivery failing with 503 is retried until it succeeds.', 'The fifth failure lands in the dead-letter queue.'],
  outOfScope: ['Replaying dead-lettered deliveries.'],
  links: ['acme/widgets#27', 'src/webhooks/deliver.ts'],
};
const handoffSheet: NonNullable<TaskView['handoff']> = {
  brief: null,
  stage: 'implement',
  continueAs: 'resume',
  autonomy: 'L1',
  tier: 'sonnet',
  maxTurns: 300,
  contextShare: 0.23,
  readiness: { blockers: [], toCommit: ['GLOSSARY.md'] },
};

const handoff: Scene = {
  name: 'handoff',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { keys: [ENTER, ENTER] },
    { hold: 800 },
    { patch: [{ op: 'set', path: ['runs', 'R1'], value: { ...GRILLING, proposal: { kind: 'advance', reason: 'The retry policy is settled.' } } }] },
    { hold: 1200 },
    { keys: [CTRL_N] },
    { hold: 2200 },
    { keys: [ESC] },
    { patch: [{ op: 'set', path: ['runs', 'R1'], value: { ...GRILLING, proposal: { kind: 'handoff', reason: 'The retry policy is settled: it is ready to build.' } } }] },
    { hold: 1000 },
    { type: '/handoff', pace: 70 },
    { keys: [ENTER] },
    // The agent writes the brief, on its turn.
    {
      patch: [
        { op: 'set', path: ['tasks', 'T1'], value: { ...CONVERSING, handoff: handoffSheet } },
        { op: 'set', path: ['runs', 'R1'], value: { ...GRILLING, turn: 'agent' } },
      ],
    },
    { hold: 1000 },
    {
      patch: [
        { op: 'set', path: ['tasks', 'T1'], value: { ...CONVERSING, handoff: { ...handoffSheet, brief: BRIEF } } },
        { op: 'set', path: ['runs', 'R1'], value: GRILLING },
      ],
    },
    { hold: 3200 },
    { keys: [ENTER] },
    {
      patch: [
        { op: 'set', path: ['tasks', 'T1'], value: { ...CONVERSING, mode: 'AFK', autonomy: 'L1', state: 'queued', label: 'Queued', stage: 'implement', tier: 'sonnet', liveRunId: null, handoff: null } },
        { op: 'set', path: ['runs', 'R1'], value: { ...GRILLING, status: 'ended', outcome: 'handed off', endedAt: GRILLING.startedAt + 15 * 60_000 } },
      ],
    },
    { hold: 1000 },
    { keys: [CTRL_B] },
    { hold: 2000 },
  ],
};

// The stills: each screen as it stands, taller so Usage shows whole.
const screens: Scene = {
  name: 'screens',
  columns: COLUMNS,
  rows: 44,
  steps: [
    { still: 'tasks' },
    { keys: ['2'] },
    { still: 'needs-you' },
    { keys: ['3'] },
    { still: 'runs' },
    { keys: ['4'] },
    { still: 'usage' },
    { keys: ['1', 'v'] },
    { still: 'condensed' },
  ],
};

export const GIFS: Scene[] = [tasksAndLaunch, needsYou, taskDetail, handoff];
export const STILLS: Scene[] = [screens];
