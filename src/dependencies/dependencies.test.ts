// Which install a worktree's lockfile calls for, and that one already
// finished is never made again.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { installFor, lockfileDependencies } from './dependencies.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A worktree holding `files`, each empty.
function worktree(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-deps-'));
  dirs.push(dir);
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), '');
  }
  return dir;
}

describe('the install a worktree calls for', () => {
  test('is none without a lockfile', () => {
    expect(installFor(worktree('package.json'))).toBeNull();
  });

  test('is each package manager’s install from its lockfile', () => {
    expect(installFor(worktree('package-lock.json'))?.command).toEqual(['npm', 'ci', '--no-audit', '--no-fund']);
    expect(installFor(worktree('npm-shrinkwrap.json'))?.command).toEqual(['npm', 'ci', '--no-audit', '--no-fund']);
    expect(installFor(worktree('pnpm-lock.yaml'))?.command).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(installFor(worktree('yarn.lock'))?.command).toEqual(['yarn', 'install', '--frozen-lockfile']);
    expect(installFor(worktree('yarn.lock', '.yarnrc.yml'))?.command).toEqual(['yarn', 'install', '--immutable']);
  });

  test('is npm’s when the worktree has several lockfiles', () => {
    expect(installFor(worktree('yarn.lock', 'package-lock.json'))?.command[0]).toBe('npm');
  });
});

describe('installing a worktree’s dependencies', () => {
  test('runs nothing when an install has finished there', async () => {
    const dir = worktree('package-lock.json', join('node_modules', '.package-lock.json'));

    expect(await lockfileDependencies().install(dir)).toBeNull();
  });

  test('runs nothing without a lockfile', async () => {
    expect(await lockfileDependencies().install(worktree('package.json'))).toBeNull();
  });
});
