// The launch card (`N`): the repository, workflow preset, start stage, launch
// inputs, groups and model tier a task launches with, and for an AFK start
// stage the handoff fields: autonomy level (L2 runs in the task's own
// container), max turns and priority. The
// daemon resolves and freezes the preset; the card offers what it lists for
// the repository. Where the factory's App isn't installed, a preset with
// AFK stages shows why its launch is blocked, and `ctrl+o` opens the
// App's installation settings.
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { AUTONOMY_LEVELS, DEFAULT_MAX_TURNS, PRIORITIES, type AutonomyLevel, type Priority } from '../lifecycle/lifecycle.ts';
import { DEFAULT_TIER, TIERS, type Tier } from '../models/routing.ts';
import { appBlock, lackingInputs, type PresetChoice, type StartStage } from '../presets/presets.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { LaunchCommand, PresetsView } from '../protocol/protocol.ts';
import { edit, withCaret, type Caret } from './text-input.ts';
import { choosable, Cursor, joined, Sheet, tone, type Role } from './theme.ts';
import { useLaunch } from './use-launch.ts';

type Props = {
  connection: FactoryConnection;
  state: FactoryState;
  // The repository holding the TUI's working directory, if any.
  here: string | null;
  onLaunched(taskId: string): void;
  onCancel(): void;
  openUrl(url: string): void;
};

type Field = 'repo' | 'preset' | 'stage' | 'prompt' | 'issues' | 'groups' | 'autonomy' | 'tier' | 'maxTurns' | 'priority';
// What the operator picked and typed. A null choice is the default: the
// repository's preset, the preset's first start stage, the stage's tier,
// L1, normal priority. Empty max turns are the stage's. The caret is in the
// field typed into, back at its end on another.
type Draft = {
  field: Field;
  caret: Caret;
  repo: string | null;
  preset: string | null;
  stage: string | null;
  tier: Tier | null;
  autonomy: AutonomyLevel | null;
  priority: Priority | null;
  prompt: string;
  issues: string;
  groups: string;
  maxTurns: string;
};
// What the daemon listed for a repository, or why it couldn't.
type Listing = PresetsView | { refusal: string };

const LABEL = 12;
// What a launch says while no repository is registered.
export const NO_REPOSITORY = 'Register a repository first: run `agents-factory repo add` in a clone.';

// The repository a launch starts on: the one holding the working directory,
// else the last one used, else any registered one.
export function defaultRepo(state: FactoryState, here: string | null): string | null {
  const repositories = Object.keys(state.repositories);
  return [here, state.lastUsedRepo].find((repo) => repo && repositories.includes(repo)) ?? repositories[0] ?? null;
}

export function LaunchCard({ connection, state, here, onLaunched, onCancel, openUrl }: Props) {
  const repositories = Object.keys(state.repositories);
  const [draft, setDraft] = useState<Draft>(() => ({
    field: 'prompt',
    caret: null,
    repo: defaultRepo(state, here),
    preset: null,
    stage: null,
    tier: null,
    autonomy: null,
    priority: null,
    prompt: '',
    issues: '',
    groups: '',
    maxTurns: '',
  }));
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  // A launch the operator backed out of goes on, but takes them nowhere.
  const launching = useLaunch(connection);

  useEffect(() => {
    const { repo } = draft;
    if (!repo || listings[repo]) return;
    void connection.send({ type: 'listPresets', repo }).then((reply) => {
      // A daemon that acks without a listing leaves the defaults to the
      // launch, and the card says so rather than wait for one.
      const listing: Listing = !reply.ok
        ? { refusal: reply.reason }
        : reply.value
          ? (reply.value as PresetsView)
          : { refusal: 'The daemon listed no presets: the launch takes the repository’s defaults.' };
      setListings((listings) => ({ ...listings, [repo]: listing }));
    });
  }, [connection, draft.repo]);

  // A cached check that found the App missing may be stale, as when the
  // operator has just installed it: the card asks GitHub again, and the
  // repository's state shows the answer.
  useEffect(() => {
    const { repo } = draft;
    if (repo && state.repositories[repo]?.app?.installed === false) void connection.send({ type: 'checkApp', repo });
  }, [connection, draft.repo]);

  const cardFor = (draft: Draft) =>cardOf(draft, draft.repo ? listings[draft.repo] : undefined);
  const card = cardFor(draft);
  // As last checked: the launch itself checks afresh.
  const app = draft.repo ? (state.repositories[draft.repo]?.app ?? null) : null;
  const blocked = card.choice && 'appStages' in card.choice ? appBlock(card.choice.name, card.choice.appStages, app) : null;
  const fixUrl = blocked && app && !app.installed ? app.fixUrl : null;

  useInput((input, key) => {
    if (key.escape) {
      launching.leave();
      return onCancel();
    }
    if (key.ctrl && input === 'o') {
      if (fixUrl) openUrl(fixUrl);
      return;
    }
    // The launch under way takes no other key.
    if (launching.busy()) return;
    if (key.return) {
      const command = launchCommand(draft, card);
      if (!command) return;
      setRefusal(null);
      launching.launch(command, (launched) => {
        if (launched.left) return;
        if (launched.ok) onLaunched(launched.taskId);
        else setRefusal(launched.reason);
      });
      return;
    }
    // Keys typed in one burst arrive before a re-render.
    setDraft((draft) => step(draft, cardFor(draft), repositories, input, key));
  });

  const row = (field: Field, label: string, value: ReactNode, choice = true) => {
    const focused = draft.field === field;
    const shown = typeof value === 'string' && focused ? (choice ? choosable(value) : withCaret(value, draft.caret)) : value;
    return h(
      Box,
      { key: field, gap: 1 },
      h(Cursor, { on: focused }),
      h(Text, tone('dim'), label.padEnd(LABEL)),
      typeof shown === 'string' ? h(Text, null, shown) : shown,
    );
  };
  const note = (key: string, text: string, role: Role = 'dim') => h(Box, { key, marginLeft: LABEL + 3 }, h(Text, tone(role), text));

  if (!draft.repo) return h(Sheet, { title: 'Launch a task', hint: 'esc back' }, h(Text, tone('warn'), NO_REPOSITORY));
  const { listing, choice, start } = card;
  const afk = start?.mode === 'AFK';
  const maxTurnsDefault = `stage default (${start?.maxTurns ?? DEFAULT_MAX_TURNS})`;
  return h(
    Sheet,
    { title: 'Launch a task', hint: 'enter launch · ↑↓ field · ←→ choose · esc back' },
    row('repo', 'Repository', draft.repo),
    row(
      'preset',
      'Preset',
      listing === undefined
        ? 'loading…'
        : 'refusal' in listing
          ? h(Text, tone('bad'), listing.refusal)
          : choice
            ? `${choice.name} (${choice.source})`
            : 'none',
    ),
    choice && 'error' in choice ? note('error', choice.error, 'bad') : null,
    choice && 'description' in choice && choice.description ? note('description', choice.description) : null,
    row('stage', 'Start stage', start ? describeStage(start) : '—'),
    row('prompt', 'Prompt', draft.prompt, false),
    card.fields.includes('issues') ? row('issues', 'Issues', draft.issues, false) : null,
    row('groups', 'Groups', draft.groups, false),
    afk ? row('autonomy', 'Autonomy', autonomyText(draft.autonomy ?? 'L1')) : null,
    row('tier', 'Model tier', draft.tier ?? `stage default${start ? ` (${start.model ?? DEFAULT_TIER})` : ''}`),
    afk
      ? row(
          'maxTurns',
          'Max turns',
          draft.maxTurns || draft.field === 'maxTurns' ? draft.maxTurns : h(Text, tone('dim'), maxTurnsDefault),
          false,
        )
      : null,
    afk ? row('priority', 'Priority', draft.priority ?? 'normal') : null,
    listing && 'warning' in listing && listing.warning ? h(Text, tone('warn'), listing.warning) : null,
    blocked ? h(Text, tone('bad'), blocked) : null,
    fixUrl ? h(Text, tone('dim'), 'ctrl+o opens its installation settings') : null,
    launching.indicator,
    refusal ? h(Text, tone('bad'), refusal) : null,
  );
}

type Card = {
  listing: Listing | undefined;
  // The preset picked, if the listing came, and the start stage it is on.
  choice: PresetChoice | undefined;
  start: StartStage | undefined;
  presets: PresetChoice[];
  starts: StartStage[];
  fields: Field[];
};

// The card as the draft and the repository's listing make it.
function cardOf(draft: Draft, listing: Listing | undefined): Card {
  const presets = listing && 'presets' in listing ? listing.presets : [];
  const name = draft.preset ?? (listing && 'defaultPreset' in listing ? listing.defaultPreset : null);
  const choice = presets.find((preset) => preset.name === name);
  const starts = choice && 'startStages' in choice ? choice.startStages : [];
  const start = starts.find((stage) => stage.id === draft.stage) ?? starts[0];
  const fields: Field[] = ['repo', 'preset', 'stage', 'prompt'];
  if (start?.needs.includes('issues')) fields.push('issues');
  fields.push('groups');
  if (start?.mode === 'AFK') fields.push('autonomy');
  fields.push('tier');
  if (start?.mode === 'AFK') fields.push('maxTurns', 'priority');
  return { listing, choice, start, presets, starts, fields };
}

// The draft after a key that isn't enter or esc.
function step(draft: Draft, card: Card, repositories: string[], input: string, key: Key): Draft {
  if (key.upArrow || key.downArrow) {
    const at = card.fields.indexOf(draft.field);
    const next = Math.min(Math.max(at + (key.upArrow ? -1 : 1), 0), card.fields.length - 1);
    return next === at ? draft : { ...draft, field: card.fields[next]!, caret: null };
  }
  if (draft.field === 'prompt' || draft.field === 'issues' || draft.field === 'groups' || draft.field === 'maxTurns') {
    // Max turns are a whole number: other characters are dropped.
    const typed = edit(draft[draft.field], draft.caret, draft.field === 'maxTurns' && !key.meta ? input.replace(/\D/g, '') : input, key);
    return typed === null ? draft : { ...draft, [draft.field]: typed.text, caret: typed.caret };
  }
  if (key.leftArrow || key.rightArrow) {
    const by = key.leftArrow ? -1 : 1;
    switch (draft.field) {
      case 'repo':
        return { ...draft, repo: cycle(repositories, draft.repo, by), preset: null, stage: null };
      case 'preset':
        return { ...draft, preset: cycle(card.presets.map(({ name }) => name), card.choice?.name ?? null, by), stage: null };
      case 'stage':
        return { ...draft, stage: cycle(card.starts.map(({ id }) => id), card.start?.id ?? null, by) };
      case 'tier':
        return { ...draft, tier: cycle([null, ...TIERS], draft.tier, by) };
      case 'autonomy':
        return { ...draft, autonomy: cycle(AUTONOMY_LEVELS, draft.autonomy ?? 'L1', by) };
      case 'priority':
        return { ...draft, priority: cycle(PRIORITIES, draft.priority ?? 'normal', by) };
      default:
        return draft;
    }
  }
  return draft;
}

// The value `by` steps from `current` in `values`, wrapping round.
export function cycle<T>(values: readonly T[], current: T, by: number): T {
  if (values.length === 0) return current;
  const at = values.indexOf(current);
  return values[(at + by + values.length) % values.length]!;
}

// What enter sends, or null while the card can't launch: it needs a
// repository and the launch inputs the start stage needs (all of them, or
// one when it takes either; a prompt, when the card has no listing to know).
// Defaults are left to the daemon when the card has no listing to choose from.
function launchCommand(draft: Draft, card: Card): LaunchCommand | null {
  const issues = card.fields.includes('issues') ? words(draft.issues) : [];
  const needs = card.start?.needs ?? (card.choice ? [] : ['prompt']);
  if (!draft.repo || lackingInputs({ needs, anyOf: card.start?.anyOf }, { prompt: draft.prompt, issues }).length > 0) return null;
  const groups = words(draft.groups);
  // The handoff fields go only for an AFK start stage, and only when changed.
  const afk = card.start?.mode === 'AFK';
  return {
    type: 'launchTask',
    repo: draft.repo,
    ...(card.choice && { preset: card.choice.name }),
    ...(card.start && { stage: card.start.id }),
    prompt: draft.prompt,
    ...(issues.length > 0 && { issues }),
    ...(groups.length > 0 && { groups }),
    ...(draft.tier && { tier: draft.tier }),
    ...(afk && draft.autonomy && { autonomy: draft.autonomy }),
    ...(afk && draft.maxTurns && { maxTurns: Number(draft.maxTurns) }),
    ...(afk && draft.priority && { priority: draft.priority }),
  };
}

// An autonomy level, with where its runs execute (ADR 0007).
export function autonomyText(level: AutonomyLevel): string {
  return level === 'L2' ? 'L2 (in its own container)' : 'L1 (on this machine)';
}

function words(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

function describeStage({ id, mode, model }: StartStage): string {
  return joined([id, mode, model]);
}
