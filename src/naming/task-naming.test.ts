import { describe, expect, test } from 'vitest';
import { nameTask, namingRequest, parseName, type Namer } from './task-naming.ts';

const replying = (text: string): Namer => async () => text;

describe('parseName', () => {
  test('reads the model’s JSON, fenced or not', () => {
    const reply = '```json\n{"title": "Agent-written task names", "slug": "agent-written-task-names", "summary": "Names tasks with a model."}\n```';
    expect(parseName(reply)).toEqual({ title: 'Agent-written task names', slug: 'agent-written-task-names', summary: 'Names tasks with a model.' });
  });

  test('cleans the slug as any branch slug is cleaned, and falls back to the title’s', () => {
    expect(parseName('{"title": "Fix it", "slug": "Fix Café_Login!!"}')).toEqual({ title: 'Fix it', slug: 'fix-cafe-login', summary: null });
    expect(parseName('{"title": "Fix the login page", "slug": "***"}')!.slug).toBe('fix-the-login-page');
  });

  test('keeps a long title within the row at a word boundary, with no ellipsis', () => {
    const long = 'Replace the fixed-length prompt truncation with model-written titles for tasks, branches and pull requests';
    const { title } = parseName(JSON.stringify({ title: long, slug: 'x' }))!;
    expect(title.length).toBeLessThanOrEqual(72);
    expect(long.startsWith(title)).toBe(true);
    expect(long[title.length]).toBe(' ');
    expect(title).not.toContain('…');
  });

  test('is null for anything without a usable title', () => {
    expect(parseName('I can’t name this.')).toBeNull();
    expect(parseName('{"slug": "a-slug"}')).toBeNull();
    expect(parseName('{"title": "  "}')).toBeNull();
    expect(parseName('{"title": "x", ')).toBeNull();
    expect(parseName('["title"]')).toBeNull();
  });
});

describe('namingRequest', () => {
  test('is the prompt, or without one the issue refs and preset, or the preset alone', () => {
    expect(namingRequest('  Add a logout button.  ', ['#12'], 'implement')).toBe('Add a logout button.');
    expect(namingRequest('', ['acme/widgets#12', 'acme/widgets#13'], 'implement')).toBe('Work on the issues acme/widgets#12, acme/widgets#13 with the implement workflow.');
    expect(namingRequest('', ['acme/widgets#12'], undefined)).toBe('Work on the issues acme/widgets#12.');
    expect(namingRequest('', [], 'setup')).toBe('Run the setup workflow.');
    expect(namingRequest('', [], undefined)).toBe('');
  });
});

describe('nameTask', () => {
  test('names the request through the namer', async () => {
    expect(await nameTask(replying('{"title": "Add logout", "slug": "add-logout", "summary": "Adds a logout button."}'), 'Add a logout button.')).toEqual({
      title: 'Add logout',
      slug: 'add-logout',
      summary: 'Adds a logout button.',
    });
  });

  test('is null without a namer or a request, when the namer fails, and when it takes too long, which aborts it', async () => {
    expect(await nameTask(undefined, 'Add a logout button.')).toBeNull();
    expect(await nameTask(replying('{"title": "x"}'), '   ')).toBeNull();
    expect(await nameTask(() => Promise.reject(new Error('offline')), 'Add a logout button.')).toBeNull();
    let aborted = false;
    const hanging: Namer = (_request, signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true)));
    expect(await nameTask(hanging, 'Add a logout button.', 20)).toBeNull();
    expect(aborted).toBe(true);
  });
});
