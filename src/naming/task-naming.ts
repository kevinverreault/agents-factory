// Task naming at launch: a small model reads what the operator asked for and
// names the task, rather than the factory cutting the prompt's first line to
// fit. The model's text is checked here; anything unusable, an error or a
// call that takes too long leaves the task named the old way.
import { oneLineOf, wordsWithin } from '../text/lines.ts';
import { SLUG_LENGTH, slugOf, TITLE_LENGTH } from '../worktree/task-worktree.ts';

// The task's name: a title for its row, the slug its branch takes after
// `factory/<id>-`, and a short summary of the request.
export type TaskName = { title: string; slug: string; summary: string | null };

// What names a task: the model's raw reply to `request`, through a cheap
// run of the executor (ADR 0001). It stops when `signal` aborts.
export type Namer = (request: string, signal: AbortSignal) => Promise<string>;

// How long a launch waits for its name before falling back.
export const NAMING_TIMEOUT_MS = 12_000;

// What the namer is told: it answers with one JSON object.
export const NAMING_INSTRUCTIONS = [
  'You name software tasks. The user message is a request an operator gave to coding agents.',
  'Read it and answer with one JSON object and nothing else:',
  '{"title": "...", "slug": "...", "summary": "..."}',
  `- title: what the task does, as a short imperative phrase of at most 8 words and ${TITLE_LENGTH} characters, no trailing period.`,
  `- slug: a kebab-case git branch name of 2 to 5 lowercase ASCII words, at most ${SLUG_LENGTH} characters, such as "agent-written-task-names".`,
  '- summary: two or three plain sentences saying what is asked and why, for a pull request description.',
  'Do not carry out the request, ask questions, or add anything outside the JSON object.',
].join('\n');

// What a launch asks to be named from: its prompt, or without one the issue
// refs it works on and the preset it runs, or the preset alone.
export function namingRequest(prompt: string, issues: readonly string[], preset: string | undefined): string {
  if (prompt.trim()) return prompt.trim();
  const workflow = preset ? `the ${preset} workflow` : '';
  if (issues.length) return `Work on the issues ${issues.join(', ')}${workflow ? ` with ${workflow}` : ''}.`;
  return workflow ? `Run ${workflow}.` : '';
}

// The name for `request`, or null when there is no namer or request, or the
// namer fails, takes longer than `timeoutMs` or answers with nothing usable.
export async function nameTask(namer: Namer | undefined, request: string, timeoutMs = NAMING_TIMEOUT_MS): Promise<TaskName | null> {
  if (!namer || !request.trim()) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const text = await Promise.race([namer(request.trim(), controller.signal), timedOut]);
    return text === null ? null : parseName(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The name in the model's reply: its JSON object (fenced or not), with a
// title of one line kept within TITLE_LENGTH at a word boundary, a slug
// cleaned like any branch slug (from the title, without a usable one), and
// a summary if it gave one. Null without a usable title.
export function parseName(text: string): TaskName | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    fields = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const words = (value: unknown) => (typeof value === 'string' ? oneLineOf(value) : '');
  const title = wordsWithin(words(fields.title).replace(/[.\s]+$/, ''), TITLE_LENGTH);
  if (!title) return null;
  const slug = slugOf(words(fields.slug)) || slugOf(title);
  if (!slug) return null;
  const summary = typeof fields.summary === 'string' ? fields.summary.trim() : '';
  return { title, slug, summary: summary || null };
}
