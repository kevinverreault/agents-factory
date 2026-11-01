#!/usr/bin/env node
// agents-factory: with no arguments, opens the TUI (starting the daemon if
// none is running). `daemon status` and `daemon stop` inspect and stop it;
// `repo add`, `repo move` and `repo remove` register, re-point and unregister
// the operator's clones; `skills update` and `skills status` move and inspect
// the skill set pin; `models update` moves each model tier to the model this
// factory ships; `setup github` creates the factory's GitHub App. `hook`
// is run by Claude Code, not the operator: it relays a run's hook events
// to the daemon.
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createElement as h } from 'react';
import { render } from 'ink';
import { connectOrStart } from './daemon/auto-start.ts';
import { factoryPaths } from './daemon/paths.ts';
import { setUpGitHub } from './github/setup-command.ts';
import { relayHook } from './hooks/relay.ts';
import { modelsCommand } from './models/models-command.ts';
import { openUrl } from './os/open-url.ts';
import { connect, HandshakeRefused, isNoDaemon, type FactoryConnection } from './protocol/client.ts';
import type { RepositoryView } from './protocol/factory-state.ts';
import type { Command, DaemonStatus } from './protocol/protocol.ts';
import { skillsCommand } from './skills/skills-command.ts';
import { App } from './tui/app.ts';

const USAGE = [
  'Usage: agents-factory',
  '       agents-factory daemon status | daemon stop',
  '       agents-factory repo add [path] [--base-branch <branch>] [--default-preset <preset>]',
  '       agents-factory repo move <new-path>',
  '       agents-factory repo remove <owner/name>',
  '       agents-factory skills update | skills status',
  '       agents-factory models update',
  '       agents-factory setup github [--name <app-name>]',
].join('\n');

// The manifest flow's code is valid for an hour.
const SETUP_TIMEOUT_MS = 60 * 60_000;

async function main(args: string[]): Promise<number> {
  const paths = factoryPaths();
  if (args.length === 0) {
    const connection = await connectOrStart(paths);
    // Closing the TUI closes only this connection; the daemon keeps running.
    await render(h(App, { connection, cwd: process.cwd() })).waitUntilExit();
    connection.close();
    return 0;
  }
  if (args[0] === 'daemon' && (args[1] === 'status' || args[1] === 'stop') && args.length === 2) {
    let connection: FactoryConnection;
    try {
      connection = await connect(paths);
    } catch (error) {
      if (!isNoDaemon(error)) throw error;
      console.log('The daemon is not running.');
      return args[1] === 'stop' ? 0 : 3;
    }
    const reply = await connection.send({ type: args[1] === 'status' ? 'daemon.status' : 'daemon.stop' });
    connection.close();
    if (!reply.ok) {
      console.error(reply.reason);
      return 1;
    }
    console.log(args[1] === 'status' ? describe(reply.value as DaemonStatus) : 'The daemon stopped.');
    return 0;
  }
  if (args[0] === 'hook' && args.length === 1) {
    // Never starts the daemon: a run's hook events matter only to the daemon running it.
    await relayHook(await text(process.stdin), paths);
    return 0;
  }
  if (args[0] === 'repo') {
    const command = repoCommand(args.slice(1));
    if (!command) {
      console.error(USAGE);
      return 2;
    }
    const connection = await connectOrStart(paths);
    const reply = await connection.send(command);
    connection.close();
    if (!reply.ok) {
      console.error(reply.reason);
      return 1;
    }
    if (command.type === 'registerRepo') {
      const { id, path, baseBranch, defaultPreset, app, skills } = reply.value as RepositoryView;
      console.log(`Registered ${id} at ${path} (base branch ${baseBranch}, default preset ${defaultPreset}).`);
      if (app && !app.installed) console.log(app.fixUrl ? `${app.reason} Install it there: ${app.fixUrl}` : app.reason);
      if (skills && !skills.present) console.log(skills.failed ? skills.reason : `${skills.reason} Set it up from the TUI with s (Set up now).`);
    } else if (command.type === 'moveRepo') {
      const { id, path } = reply.value as RepositoryView;
      console.log(`Moved ${id} to ${path}.`);
    } else {
      console.log(`Removed ${command.repo}.`);
    }
    return 0;
  }
  if (args[0] === 'skills' && (args[1] === 'update' || args[1] === 'status') && args.length === 2) {
    return skillsCommand(args[1], paths);
  }
  if (args[0] === 'models' && args[1] === 'update' && args.length === 2) return modelsCommand(paths);
  if (args[0] === 'setup' && args[1] === 'github') {
    const name = setupName(args.slice(2));
    if (name === null) {
      console.error(USAGE);
      return 2;
    }
    const connection = await connectOrStart(paths);
    try {
      return await setUpGitHub({ connection, name, openUrl, print: (line) => console.log(line), signal: AbortSignal.timeout(SETUP_TIMEOUT_MS) });
    } finally {
      connection.close();
    }
  }
  console.error(USAGE);
  return 2;
}

// `repo add [path] [--base-branch b] [--default-preset p]`,
// `repo move <new-path>` or `repo remove <owner/name>`, or null when the
// arguments don't fit.
function repoCommand(args: string[]): Extract<Command, { type: 'registerRepo' | 'moveRepo' | 'removeRepo' }> | null {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { 'base-branch': { type: 'string' }, 'default-preset': { type: 'string' } },
    });
  } catch {
    return null;
  }
  const { positionals, values } = parsed;
  const [verb, operand, ...rest] = positionals;
  if (rest.length) return null;
  if (verb === 'add') {
    // The daemon's working directory isn't ours, so the path goes absolute.
    return {
      type: 'registerRepo',
      path: resolve(operand ?? process.cwd()),
      ...(values['base-branch'] && { baseBranch: values['base-branch'] }),
      ...(values['default-preset'] && { defaultPreset: values['default-preset'] }),
    };
  }
  if (verb === 'move' && operand && Object.keys(values).length === 0) return { type: 'moveRepo', path: resolve(operand) };
  if (verb === 'remove' && operand && Object.keys(values).length === 0) return { type: 'removeRepo', repo: operand };
  return null;
}

// The App name `setup github [--name <app-name>]` asks GitHub for, by
// default one for this OS user (a GitHub App's name is unique on GitHub and
// at most 34 characters), or null when the arguments don't fit.
function setupName(args: string[]): string | null {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { name: { type: 'string' } } });
  } catch {
    return null;
  }
  const forThisUser = `agents-factory-${userInfo().username.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 34).replace(/-+$/, '');
  return parsed.values.name?.trim() || forThisUser;
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let read = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) read += chunk;
  return read;
}

function describe(status: DaemonStatus): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    `The daemon is running (pid ${status.pid}, protocol ${status.protocolVersion}), up since ${new Date(status.startedAt).toISOString()}.`,
    `${plural(status.attachedTuis, 'TUI')} attached, ${plural(status.activeRuns, 'active run')}, ` +
      `${plural(status.suspendedRuns, 'suspended run')}, ${plural(status.queuedTasks, 'queued task')}.`,
  ].join('\n');
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  if (!(error instanceof HandshakeRefused)) throw error;
  console.error(error.message);
  return 1;
});
