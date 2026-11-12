import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { filePrefs } from './prefs.ts';

describe('the TUI settings file', () => {
  const dirs: string[] = [];
  const dir = () => {
    const made = mkdtempSync(join(tmpdir(), 'tui-prefs-'));
    dirs.push(made);
    return made;
  };
  afterEach(() => {
    for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
  });

  test('a missing file loads as every task shown', () => {
    expect(filePrefs(join(dir(), 'tui.json')).load()).toEqual({ hideFinished: false });
  });

  test('what one session saves, the next loads', () => {
    const path = join(dir(), 'nested', 'tui.json');
    filePrefs(path).save({ hideFinished: true });
    expect(filePrefs(path).load()).toEqual({ hideFinished: true });
    filePrefs(path).save({ hideFinished: false });
    expect(filePrefs(path).load()).toEqual({ hideFinished: false });
  });

  test.each(['{not json', '[]', 'null', '{"hideFinished":"yes"}'])('a malformed file (%s) loads as every task shown, and the next save rewrites it', (content) => {
    const path = join(dir(), 'tui.json');
    writeFileSync(path, content);
    const prefs = filePrefs(path);
    expect(prefs.load()).toEqual({ hideFinished: false });
    prefs.save({ hideFinished: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hideFinished: true });
  });

  test('a save that cannot be written does not throw', () => {
    const blocker = join(dir(), 'file');
    writeFileSync(blocker, '');
    expect(() => filePrefs(join(blocker, 'tui.json')).save({ hideFinished: true })).not.toThrow();
  });
});
