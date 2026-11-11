// The README's media, each a scene played on the demo factory: a GIF of
// what the operator does, or the stills of the screens as they stand.
import type { PatchOp, RunView, TaskView } from '../protocol/factory-state.ts';
import { CONVERSING, demoState, GRILLING, MINUTE } from './demo-factory.ts';
import type { Scene } from './stage.ts';

const [UP, DOWN, ENTER, ESC, CTRL_N, CTRL_B] = ['\x1b[A', '\x1b[B', '\r', '\x1b', '\x0e', '\x02'];
// A typist's pace, ms a key.
const TYPING = 30;
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

// A change from the daemon to one task or one run.
const setTask = (task: TaskView): PatchOp => ({ op: 'set', path: ['tasks', task.id], value: task });
const setRun = (run: RunView): PatchOp => ({ op: 'set', path: ['runs', run.id], value: run });

const tasksAndLaunch: Scene = {
  name: 'tasks-and-launch',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { hold: 600 },
    { keys: [DOWN] },
    { hold: 900 },
    { keys: ['n'] },
    { text: QUICK_PROMPT, pace: TYPING },
    { keys: [ENTER] },
    { patch: [setTask(quickTask), setRun(quickRun)] },
    { hold: 1200 },
    { keys: ['1'] },
    { patch: [setRun({ ...quickRun, question: null })] },
    {
      converse: 'R10',
      events: [
        { type: 'toolUse', id: 'E1', tool: 'Read', summary: 'src/sync/command.ts' },
        { type: 'message', id: 'E2', from: 'agent', text: 'A diff it is. Should --dry-run exit non-zero when something would change?' },
      ],
    },
    { hold: 1000 },
  ],
};

const needsYou: Scene = {
  name: 'needs-you',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { keys: ['2'] },
    { hold: 700 },
    { keys: ['a'] },
    { keys: ['1'] },
    {
      patch: [
        { op: 'set', path: ['attentionQueue'], value: seeded.attentionQueue.slice(1) },
        setTask({ ...T5, state: 'running', label: 'Running' }),
        setRun({ ...R5, question: null }),
      ],
    },
    { hold: 900 },
    { keys: [DOWN] },
    { hold: 900 },
  ],
};

const REPLY = 'Only 5xx and timeouts. Never 4xx.';
const taskDetail: Scene = {
  name: 'task-detail',
  columns: COLUMNS,
  rows: ROWS,
  steps: [
    { keys: [DOWN, ENTER] },
    { hold: 1000 },
    { keys: [ESC, UP, ENTER, ENTER] },
    { hold: 600 },
    { text: REPLY, pace: TYPING },
    { keys: [ENTER] },
    { patch: [setRun({ ...GRILLING, turn: 'agent' })] },
    {
      converse: 'R1',
      events: [
        { type: 'message', id: 'E5', from: 'operator', text: REPLY },
        { type: 'toolUse', id: 'E6', tool: 'Read', summary: 'src/webhooks/queue.ts' },
        { type: 'message', id: 'E7', from: 'agent', text: 'Settled: 5xx and timeouts retry, 4xx never. How many attempts before a delivery is dead-lettered?' },
      ],
    },
    { patch: [setRun(GRILLING)] },
    { hold: 1200 },
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
    { patch: [setRun({ ...GRILLING, proposal: { kind: 'advance', reason: 'The retry policy is settled.' } })] },
    { keys: [CTRL_N] },
    { hold: 900 },
    { keys: [ESC] },
    { patch: [setRun({ ...GRILLING, proposal: { kind: 'handoff', reason: 'The retry policy is settled: it is ready to build.' } })] },
    { text: '/handoff', pace: TYPING },
    { keys: [ENTER] },
    // The agent writes the brief, on its turn.
    { patch: [setTask({ ...CONVERSING, handoff: handoffSheet }), setRun({ ...GRILLING, turn: 'agent' })] },
    { patch: [setTask({ ...CONVERSING, handoff: { ...handoffSheet, brief: BRIEF } }), setRun(GRILLING)] },
    { hold: 1600 },
    { keys: [ENTER] },
    {
      patch: [
        setTask({ ...CONVERSING, mode: 'AFK', autonomy: 'L1', state: 'queued', label: 'Queued', stage: 'implement', tier: 'sonnet', liveRunId: null, handoff: null }),
        setRun({ ...GRILLING, status: 'ended', outcome: 'handed off', endedAt: GRILLING.startedAt + 15 * MINUTE }),
      ],
    },
    { keys: [CTRL_B] },
    { hold: 1200 },
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
