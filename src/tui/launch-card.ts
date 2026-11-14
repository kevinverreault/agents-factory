// The launch card (`N`): the repository, workflow preset, start stage, launch
// inputs, groups and model tier a task launches with, and for an AFK start
// stage the handoff fields: autonomy level (L2 runs in the task's own
// container), at L3 the merge policy (ADR 0014), max turns and priority. The
// daemon resolves and freezes the preset; the card offers what it lists for
// the repository. Where the factory's App isn't installed, a preset with
// AFK stages shows why its launch is blocked, and `ctrl+o` opens the
// App's installation settings. The prompt takes several lines (text-area.ts),
// and `ctrl+e` opens it in the operator's own editor.
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput, usePaste, type Key } from 'ink';
import { AUTONOMY_LEVELS, DEFAULT_MAX_TURNS, l3Refusal, OFFERED_POLICIES, POLICY_NAMES, PRIORITIES, type AutonomyLevel, type MergePolicy, type Priority } from '../lifecycle/lifecycle.ts';
import { DEFAULT_TIER, TIERS, type Tier } from '../models/routing.ts';
import type { Edited } from '../os/edit-externally.ts';
import { appBlock, lackingInputs, type PresetChoice, type StartStage } from '../presets/presets.ts';
import type { FactoryConnection } from '../protocol/client.ts';
import type { FactoryState } from '../protocol/factory-state.ts';
import type { LaunchCommand, PresetsView } from '../protocol/protocol.ts';
import { lineBreaks } from '../text/lines.ts';
import { useColumns } from './screen.ts';
import { editArea, windowed } from './text-area.ts';
import { edit, insert, withCaret, type Caret } from './text-input.ts';
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
  // The prompt as the operator saved it in their own editor.
  editText(text: string): Promise<Edited>;
};

type Field = 'repo' | 'preset' | 'stage' | 'prompt' | 'issues' | 'groups' | 'autonomy' | 'mergePolicy' | 'tier' | 'maxTurns' | 'priority';
// The fields typed in, rather than chosen from.
type TypedField = 'prompt' | 'issues' | 'groups' | 'maxTurns';
const isTyped = (field: Field): field is TypedField => field === 'prompt' || field === 'issues' || field === 'groups' || field === 'maxTurns';
// What the operator picked and typed. A null choice is the default: the
// repository's preset, the preset's first start stage, the stage's tier,
// L1, the operator policy, normal priority. Empty max turns are the stage's. The caret is in the
// field typed into, back at its end on another.
type Draft = {
  field: Field;
  caret: Caret;
  repo: string | null;
  preset: string | null;
  stage: string | null;
  tier: Tier | null;
  autonomy: AutonomyLevel | null;
  mergePolicy: MergePolicy | null;
  priority: Priority | null;
  prompt: string;
  issues: string;
  groups: string;
  maxTurns: string;
  // ctrl+e asked for the operator's editor, until it gives the prompt back.
  editing: boolean;
};
// What the daemon listed for a repository, or why it couldn't.
type Listing = PresetsView | { refusal: string };

const LABEL = 12;
// The most rows of the prompt on show at once, around its caret's.
const PROMPT_ROWS = 8;
// The columns left of the prompt's value column and right of it: the
// sheet's border and padding, the cursor, the label and the gaps.
const PROMPT_INSET = LABEL + 3 + 4;
// What a launch says while no repository is registered.
export const NO_REPOSITORY = 'Register a repository first: run `agents-factory repo add` in a clone.';

// The repository a launch starts on: the one holding the working directory,
// else the last one used, else any registered one.
export function defaultRepo(state: FactoryState, here: string | null): string | null {
  const repositories = Object.keys(state.repositories);
  return [here, state.lastUsedRepo].find((repo) => repo && repositories.includes(repo)) ?? repositories[0] ?? null;
}

export function LaunchCard({ connection, state, here, onLaunched, onCancel, openUrl, editText }: Props) {
  const repositories = Object.keys(state.repositories);
  const [draft, setDraft] = useState<Draft>(() => ({
    field: 'prompt',
    caret: null,
    repo: defaultRepo(state, here),
    preset: null,
    stage: null,
    tier: null,
    autonomy: null,
    mergePolicy: null,
    priority: null,
    prompt: '',
    issues: '',
    groups: '',
    maxTurns: '',
    editing: false,
  }));
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  // A launch the operator backed out of goes on, but takes them nowhere.
  const launching = useLaunch(connection);
  const { suspendTerminal } = useApp();
  const columns = useColumns();

  // Once ctrl+e asks for it, the terminal goes to the operator's editor
  // while it runs, and the prompt they saved comes back with the caret at
  // its end.
  useEffect(() => {
    if (!draft.editing) return;
    setRefusal(null);
    void new Promise<Edited>((resolve) => {
      suspendTerminal(async () => resolve(await editText(draft.prompt))).catch((error: unknown) =>
        resolve({ ok: false, reason: `Couldn't open an editor: ${String(error)}` }),
      );
    }).then((edited) => {
      setDraft((draft) => ({ ...draft, editing: false, ...(edited.ok && { prompt: edited.text, caret: null }) }));
      if (!edited.ok) setRefusal(edited.reason);
    });
  }, [draft.editing]);

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
  // So may one that found L3's permissions ungranted, once L3 is picked.
  useEffect(() => {
    const { repo } = draft;
    const app = repo ? state.repositories[repo]?.app : undefined;
    if (repo && app && (!app.installed || (draft.autonomy === 'L3' && l3Refusal(repo, app)))) void connection.send({ type: 'checkApp', repo });
  }, [connection, draft.repo, draft.autonomy === 'L3']);

  const cardFor = (draft: Draft) =>cardOf(draft, draft.repo ? listings[draft.repo] : undefined);
  const card = cardFor(draft);
  // As last checked: the launch itself checks afresh.
  const app = draft.repo ? (state.repositories[draft.repo]?.app ?? null) : null;
  const blocked = card.choice && 'appStages' in card.choice ? appBlock(card.choice.name, card.choice.appStages, app) : null;
  // L3 is refused, never lowered to L2, where the App's installation lacks
  // what it needs (ADR 0014): the card says so before the launch does.
  const refusedL3 = !blocked && card.start?.mode === 'AFK' && draft.autonomy === 'L3' && draft.repo ? l3Refusal(draft.repo, app) : null;
  const fixUrl = blocked && app && !app.installed ? app.fixUrl : (refusedL3?.fixUrl ?? null);

  useInput((input, key) => {
    if (key.escape) {
      launching.leave();
      return onCancel();
    }
    if (key.ctrl && input === 'o') {
      if (fixUrl) openUrl(fixUrl);
      return;
    }
    // The launch under way, or the editor, takes no other key.
    if (launching.busy() || draft.editing) return;
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

  // Pasted text, line breaks and all, never reads as keys: a line break in
  // it can't launch. Only the prompt keeps them.
  usePaste((text) => {
    if (launching.busy()) return;
    setDraft((draft) => {
      if (draft.editing || !isTyped(draft.field)) return draft;
      const pasted = draft.field === 'prompt' ? lineBreaks(text) : draft.field === 'maxTurns' ? text.replace(/\D/g, '') : text.replace(/\s+/g, ' ');
      const typed = insert(draft[draft.field], draft.caret, pasted);
      return { ...draft, [draft.field]: typed.text, caret: typed.caret };
    });
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
    {
      title: 'Launch a task',
      hint:
        draft.field === 'prompt'
          ? 'enter launch · ctrl+j new line · ctrl+e editor · ↑↓ line/field · esc back'
          : 'enter launch · ↑↓ field · ←→ choose · esc back',
    },
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
    row('prompt', 'Prompt', promptText(draft.prompt, draft.field === 'prompt' ? draft.caret : undefined, columns - PROMPT_INSET)),
    card.fields.includes('issues') ? row('issues', 'Issues', draft.issues, false) : null,
    row('groups', 'Groups', draft.groups, false),
    afk ? row('autonomy', 'Autonomy', autonomyText(draft.autonomy ?? 'L1')) : null,
    refusedL3 ? note('l3', refusedL3.reason, 'bad') : null,
    card.fields.includes('mergePolicy') ? row('mergePolicy', 'Merge policy', policyText(draft.mergePolicy ?? 'operator')) : null,
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
    fixUrl ? h(Text, tone('dim'), refusedL3 ? 'ctrl+o opens its installation settings, to approve them' : 'ctrl+o opens its installation settings') : null,
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
  // Only L3 lets the factory merge, so only L3 offers a policy that does.
  if (start?.mode === 'AFK' && draft.autonomy === 'L3') fields.push('mergePolicy');
  fields.push('tier');
  if (start?.mode === 'AFK') fields.push('maxTurns', 'priority');
  return { listing, choice, start, presets, starts, fields };
}

// The prompt over its lines, those around the caret while it is typed in,
// under the value column, with how many more there are above and below.
function promptText(prompt: string, caret: Caret | undefined, width: number): ReactNode {
  const { shown, above, below } = windowed(prompt, caret, PROMPT_ROWS, Math.max(width, 10));
  const more = (key: string, lines: number, where: string) =>
    lines > 0 ? h(Text, { key, ...tone('dim') }, `… ${lines} more line${lines === 1 ? '' : 's'} ${where}`) : null;
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 1 },
    more('above', above, 'above'),
    h(Text, { key: 'prompt' }, shown),
    more('below', below, 'below'),
  );
}

// The draft after a key that isn't enter or esc.
function step(draft: Draft, card: Card, repositories: string[], input: string, key: Key): Draft {
  // ctrl+e asks for the operator's editor, on the prompt as the keys before
  // it in the burst left the draft; keys after it wait for the editor.
  if (draft.editing) return draft;
  if (key.ctrl && input === 'e') return draft.field === 'prompt' ? { ...draft, editing: true } : draft;
  // ↑ on the prompt's first line and ↓ on its last go on to the next field.
  if (draft.field === 'prompt') {
    const typed = editArea(draft.prompt, draft.caret, input, key);
    if (typed) return { ...draft, prompt: typed.text, caret: typed.caret };
  }
  if (key.upArrow || key.downArrow) {
    const at = card.fields.indexOf(draft.field);
    const next = Math.min(Math.max(at + (key.upArrow ? -1 : 1), 0), card.fields.length - 1);
    return next === at ? draft : { ...draft, field: card.fields[next]!, caret: null };
  }
  if (isTyped(draft.field)) {
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
      case 'autonomy': {
        // Below L3 the policy is the operator's again.
        const autonomy = cycle(AUTONOMY_LEVELS, draft.autonomy ?? 'L1', by);
        return { ...draft, autonomy, mergePolicy: autonomy === 'L3' ? draft.mergePolicy : null };
      }
      case 'mergePolicy':
        return { ...draft, mergePolicy: cycle(OFFERED_POLICIES, draft.mergePolicy ?? 'operator', by) };
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
    ...(card.fields.includes('mergePolicy') && draft.mergePolicy && { mergePolicy: draft.mergePolicy }),
    ...(afk && draft.maxTurns && { maxTurns: Number(draft.maxTurns) }),
    ...(afk && draft.priority && { priority: draft.priority }),
  };
}

// An autonomy level, with where its runs execute (ADR 0007), and for L3 that
// the factory may merge its PR (ADR 0014).
export function autonomyText(level: AutonomyLevel): string {
  return AUTONOMY_TEXT[level];
}

// Each level as the card and the handoff sheet show it.
const AUTONOMY_TEXT: Record<AutonomyLevel, string> = {
  L1: 'L1 (on this machine)',
  L2: 'L2 (in its own container)',
  L3: 'L3 (in its own container; the factory may merge)',
};

// A merge policy as the card, the handoff sheet and task detail show it:
// its TUI name, and who merges the task's PR (ADR 0014).
export function policyText(policy: MergePolicy): string {
  return `${POLICY_NAMES[policy]} (${POLICY_TEXT[policy]})`;
}

// Who merges a task's PR under each policy.
const POLICY_TEXT: Record<MergePolicy, string> = {
  operator: 'you merge its PR',
  judged: 'the factory merges unless it judges the PR worth your review',
  unattended: 'the factory merges its PR once its checks pass',
};

function words(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

function describeStage({ id, mode, model }: StartStage): string {
  return joined([id, mode, model]);
}
