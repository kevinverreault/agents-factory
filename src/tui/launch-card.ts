// The launch card (`N`): the repository, workflow preset, start stage, launch
// inputs, groups and model tier a task launches with. The daemon resolves and
// freezes the preset; the card offers what it lists for the repository.
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { DEFAULT_TIER, TIERS, type Tier } from '../models/routing.ts';
import type { PresetChoice, StartStage } from '../presets/presets.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { LaunchCommand, PresetsView } from '../protocol/protocol.ts';
import { edit } from './text-input.ts';

type Props = {
  connection: FactoryConnection;
  state: FactoryState;
  // The repository holding the TUI's working directory, if any.
  here: string | null;
  onLaunched(taskId: string): void;
  onCancel(): void;
};

type Field = 'repo' | 'preset' | 'stage' | 'prompt' | 'issues' | 'groups' | 'tier';
// What the operator picked and typed. A null choice is the default: the
// repository's preset, the preset's first start stage, the stage's tier.
type Draft = {
  field: Field;
  repo: string | null;
  preset: string | null;
  stage: string | null;
  tier: Tier | null;
  prompt: string;
  issues: string;
  groups: string;
};
// What the daemon listed for a repository, or why it couldn't.
type Listing = PresetsView | { refusal: string };

const LABEL = 12;

export function LaunchCard({ connection, state, here, onLaunched, onCancel }: Props) {
  const repositories = Object.keys(state.repositories);
  const [draft, setDraft] = useState<Draft>(() => ({
    field: 'prompt',
    repo: [here, state.lastUsedRepo].find((repo) => repo && repositories.includes(repo)) ?? repositories[0] ?? null,
    preset: null,
    stage: null,
    tier: null,
    prompt: '',
    issues: '',
    groups: '',
  }));
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const { repo } = draft;
    if (!repo || listings[repo]) return;
    void connection.send({ type: 'listPresets', repo }).then((reply) => {
      // A daemon that lists nothing leaves the defaults to the launch.
      if (reply.ok && !reply.value) return;
      setListings((listings) => ({ ...listings, [repo]: reply.ok ? (reply.value as PresetsView) : { refusal: reply.reason } }));
    });
  }, [connection, draft.repo]);

  const cardFor = (draft: Draft) => cardOf(draft, draft.repo ? listings[draft.repo] : undefined);
  const card = cardFor(draft);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      const command = launchCommand(draft, card);
      if (!command) return;
      void connection.send(command).then((reply) => {
        if (reply.ok) onLaunched((reply.value as { taskId: string }).taskId);
        else setRefusal(reply.reason);
      });
      return;
    }
    // Keys typed in one burst arrive before a re-render.
    setDraft((draft) => step(draft, cardFor(draft), repositories, input, key));
  });

  const row = (field: Field, label: string, value: ReactNode, choice = true) => {
    const focused = draft.field === field;
    const shown = typeof value === 'string' && focused ? (choice ? `‹ ${value} ›` : `${value}▏`) : value;
    return h(
      Box,
      { key: field, gap: 1 },
      h(Text, { color: 'cyan' }, focused ? '›' : ' '),
      h(Text, { dimColor: true }, label.padEnd(LABEL)),
      typeof shown === 'string' ? h(Text, null, shown) : shown,
    );
  };
  const note = (key: string, text: string, color?: string) =>
    h(Box, { key, marginLeft: LABEL + 3 }, h(Text, color ? { color } : { dimColor: true }, text));

  if (!draft.repo) {
    return h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
      h(Text, { bold: true }, 'Launch a task'),
      h(Text, { color: 'yellow' }, 'Register a repository first: run `agents-factory repo add` in a clone.'),
      h(Text, { dimColor: true }, 'esc back'),
    );
  }
  const { listing, choice, start } = card;
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    h(Text, { bold: true }, 'Launch a task'),
    row('repo', 'Repository', draft.repo),
    row(
      'preset',
      'Preset',
      listing === undefined
        ? 'loading…'
        : 'refusal' in listing
          ? h(Text, { color: 'red' }, listing.refusal)
          : choice
            ? `${choice.name} (${choice.source})`
            : 'none',
    ),
    choice && 'error' in choice ? note('error', choice.error, 'red') : null,
    choice && 'description' in choice && choice.description ? note('description', choice.description) : null,
    row('stage', 'Start stage', start ? describeStage(start) : '—'),
    row('prompt', 'Prompt', draft.prompt, false),
    card.fields.includes('issues') ? row('issues', 'Issues', draft.issues, false) : null,
    row('groups', 'Groups', draft.groups, false),
    row('tier', 'Model tier', draft.tier ?? `stage default${start ? ` (${start.model ?? DEFAULT_TIER})` : ''}`),
    listing && 'warning' in listing && listing.warning ? h(Text, { color: 'yellow' }, listing.warning) : null,
    refusal ? h(Text, { color: 'red' }, refusal) : null,
    h(Text, { dimColor: true }, 'enter launch · ↑↓ field · ←→ choose · esc back'),
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
  fields.push('groups', 'tier');
  return { listing, choice, start, presets, starts, fields };
}

// The draft after a key that isn't enter or esc.
function step(draft: Draft, card: Card, repositories: string[], input: string, key: Key): Draft {
  if (key.upArrow || key.downArrow) {
    const at = card.fields.indexOf(draft.field);
    const next = Math.min(Math.max(at + (key.upArrow ? -1 : 1), 0), card.fields.length - 1);
    return { ...draft, field: card.fields[next]! };
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
      default:
        return draft;
    }
  }
  if (draft.field === 'prompt' || draft.field === 'issues' || draft.field === 'groups') {
    const edited = edit(draft[draft.field], input, key);
    return edited === null ? draft : { ...draft, [draft.field]: edited };
  }
  return draft;
}

function cycle<T>(values: readonly T[], current: T, by: number): T {
  if (values.length === 0) return current;
  const at = values.indexOf(current);
  return values[(at + by + values.length) % values.length]!;
}

// What enter sends, or null while the card can't launch: it needs a
// repository and the launch inputs the start stage needs (a prompt, when the
// card has no listing to know). Defaults are left to the daemon when the
// card has no listing to choose from.
function launchCommand(draft: Draft, card: Card): LaunchCommand | null {
  const issues = card.fields.includes('issues') ? words(draft.issues) : [];
  const needs = card.start?.needs ?? (card.choice ? [] : ['prompt']);
  if (!draft.repo || (needs.includes('prompt') && !draft.prompt.trim()) || (needs.includes('issues') && issues.length === 0)) return null;
  const groups = words(draft.groups);
  return {
    type: 'launchTask',
    repo: draft.repo,
    ...(card.choice && { preset: card.choice.name }),
    ...(card.start && { stage: card.start.id }),
    prompt: draft.prompt,
    ...(issues.length > 0 && { issues }),
    ...(groups.length > 0 && { groups }),
    ...(draft.tier && { tier: draft.tier }),
  };
}

function words(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

function describeStage({ id, mode, model }: StartStage): string {
  return [id, mode, model].filter(Boolean).join(' · ');
}
