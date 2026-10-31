// Artifact capture: what a tool call in a run produced that the factory links
// to its task, read from the PostToolUse hook event alone. The agent needn't
// cooperate: writing the glossary or an ADR counts, whatever it says.
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HookEvent } from '../protocol/protocol.ts';

// A file artifact's path is relative to the task's worktree, with `/`. An
// issue's URL is `https://github.com/<owner>/<name>/issues/<number>`.
export type CapturedArtifact = { kind: 'file'; path: string } | { kind: 'issue'; url: string };

// Tools that write a file, and the input field naming it.
const WRITERS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
// Tools whose output only echoes files: an issue URL there was already in
// the repo, not printed by something the run did.
const ECHOES = new Set([...Object.keys(WRITERS), 'Read', 'Grep']);

const ISSUE_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/g;

// The artifacts the tool call in `event` produced for a task working in
// `repo` (`owner/name`), in its worktree at `worktree`.
export function capture(event: HookEvent, { repo, worktree }: { repo: string; worktree: string }): CapturedArtifact[] {
  return [...writtenFile(event, worktree), ...printedIssues(event, repo)];
}

function writtenFile(event: HookEvent, worktree: string): CapturedArtifact[] {
  const field = event.tool_name && WRITERS[event.tool_name];
  const target = field && (event.tool_input as Record<string, unknown> | undefined)?.[field];
  if (typeof target !== 'string') return [];
  const path = withinWorktree(worktree, resolve(event.cwd, target));
  return path && isArtifactFile(path) ? [{ kind: 'file', path }] : [];
}

// An issue URL as `owner/name#number`.
export function issueRef(url: string): string {
  const [, owner, name, , number] = new URL(url).pathname.split('/');
  return `${owner}/${name}#${number}`;
}

// Every URL of an issue in `repo` in the tool's output, once each, without
// any `#fragment`. A task's tickets live in its own repository, so other
// repositories' issues (a linked upstream bug, say) are no artifacts.
function printedIssues(event: HookEvent, repo: string): CapturedArtifact[] {
  if (!event.tool_name || ECHOES.has(event.tool_name)) return [];
  const output = typeof event.tool_response === 'string' ? event.tool_response : JSON.stringify(event.tool_response ?? '');
  const urls = [...output.matchAll(ISSUE_URL)]
    .filter(([, owner, name]) => `${owner}/${name}`.toLowerCase() === repo.toLowerCase())
    .map(([, , , number]) => `https://github.com/${repo}/issues/${number}`);
  return [...new Set(urls)].map((url) => ({ kind: 'issue', url }));
}

// The glossary at the worktree's top level, and every ADR.
function isArtifactFile(path: string): boolean {
  return path === 'GLOSSARY.md' || path.startsWith('docs/adr/');
}

// `path` relative to the worktree with `/`, or null when it is outside it.
function withinWorktree(worktree: string, path: string): string | null {
  const rest = relative(worktree, path);
  if (!rest || rest.startsWith('..') || isAbsolute(rest)) return null;
  return rest.split(sep).join('/');
}
