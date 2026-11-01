// The preset engine: workflow presets are YAML files (`<name>.preset.yaml`)
// in three scopes, built-in, user and repo. On a name clash repo wins over
// user, and user over built-in. A preset is checked against a fixed schema:
// its conditions come from a fixed vocabulary, never code, so a preset is
// safe to load from any repo.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { TIERS, type Tier } from '../models/routing.ts';
import type { AppCheck } from '../lifecycle/lifecycle.ts';
import { DEFAULT_PRESET } from '../repositories/registry.ts';

export type PresetScope = 'built-in' | 'user' | 'repo';
// Higher wins a name clash.
const RANK: Record<PresetScope, number> = { 'built-in': 0, user: 1, repo: 2 };

// One preset file as read from its scope: `path` says where, for errors.
export type PresetFile = { scope: PresetScope; name: string; path: string; content: string };

const stageFields = {
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'a stage id is lowercase letters, digits and dashes'),
  kind: z.enum(['run', 'loop', 'action']),
  skill: z.string().min(1).optional(),
  args: z.string().optional(),
  mode: z.enum(['HITL', 'AFK']),
  model: z.enum(TIERS).optional(),
  autonomy: z.enum(['L1', 'L2']).optional(),
  max_turns: z.int().positive().optional(),
  context: z.enum(['resume', 'fresh']).optional(),
  optional: z.boolean().optional(),
  exit: z.string().optional(),
  requires: z.literal('L2').optional(),
  on_findings: z.literal('fix-once').optional(),
};

const stageSchema = z.strictObject(stageFields);
export type Stage = z.infer<typeof stageSchema>;

// The fixed vocabularies (#12). An `artifact:<kind>` exit holds once the
// task has an artifact of that kind; `{{artifacts.<kind>}}` in `args` is it.
export const ARTIFACT_KINDS = ['map', 'spec', 'tickets', 'pr-body'] as const;
// The artifact kinds that are GitHub issues, which issue refs can stand for.
const ISSUE_KINDS = new Set(['map', 'spec', 'tickets']);
const EXITS = ['run-completed', 'artifact:<kind>', 'tickets-closed', 'map-cleared'];
const FACTORY_ACTIONS = ['open-pr', 'close-ticket', 'push'];
const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

// A preset file's own stages: overriding a stage it extends names only the id
// and the fields it changes.
type StageDraft = Partial<Stage> & { id: string };

const documentSchema = z.strictObject({
  description: z.string().optional(),
  // A preset extending another takes its stages (from stage `from` onward,
  // when given), overrides single ones by id and inserts its new ones where
  // they stand among those it overrides.
  extends: z.string().optional(),
  from: z.string().optional(),
  stages: z.array(z.strictObject(stageFields).partial().required({ id: true })).default([]),
});

// A preset resolved and checked, as a task freezes it. `hash` is of its
// stages: editing a file changes it only if the stages change.
export type ResolvedPreset = {
  name: string;
  description: string | null;
  source: PresetScope;
  path: string;
  hash: string;
  stages: Stage[];
};

export function resolvePreset(files: PresetFile[], name: string): { preset: ResolvedPreset } | { error: string } {
  const file = winner(files, name);
  if (!file) return { error: `There is no preset ${name}.` };
  const drafted = draftOf(files, file, [file]);
  if ('error' in drafted) return drafted;
  const checked = checkStages(drafted.stages);
  if ('error' in checked) return { error: `${where(file)}: ${checked.error}` };
  const { stages } = checked;
  const hash = createHash('sha256').update(JSON.stringify(stages)).digest('hex').slice(0, 16);
  return { preset: { name, description: drafted.description, source: file.scope, path: file.path, hash, stages } };
}

// What the operator launches a task with: prompt text, issue refs, or both.
export type LaunchInputs = { prompt: string; issues: string[] };
export type LaunchInput = 'prompt' | 'issues';

// A stage a task can start at, skipping the ones before it, and the launch
// inputs it needs. `maxTurns` is its `max_turns`, when it sets one.
export type StartStage = { id: string; mode: Stage['mode']; model: Tier | null; maxTurns?: number; needs: LaunchInput[] };

// The stages whose args the launch inputs can fill: the prompt fills
// `{{prompt}}`, and issue refs stand for the issue artifacts (map, spec,
// tickets) earlier stages would have made. A later stage that needs no
// launch input works only from what earlier stages left, so only the first
// stage may start a task with none.
export function startStages(preset: ResolvedPreset): StartStage[] {
  return preset.stages.flatMap((stage, i) => {
    const needs = new Set<LaunchInput>();
    for (const variable of variablesOf(stage)) {
      if (variable === 'prompt') needs.add('prompt');
      else if (ISSUE_KINDS.has(variable.slice('artifacts.'.length))) needs.add('issues');
      else return [];
    }
    if (i > 0 && needs.size === 0) return [];
    const maxTurns = stage.max_turns === undefined ? {} : { maxTurns: stage.max_turns };
    return [{ id: stage.id, mode: stage.mode, model: stage.model ?? null, ...maxTurns, needs: [...needs] }];
  });
}

// The first message of a start stage's first run: its skill, from the
// factory plugin (ADR 0005), invoked on its args filled from the launch
// inputs. A run with no skill sends its args alone. A loop stage gets one
// run on all its tickets for now: ADR 0006 has the factory pick one ticket
// per iteration, which the Ralph loop's own slice (#47) brings.
export function openingMessage(stage: Stage, { prompt, issues }: LaunchInputs): string {
  const filled = fillOpening(stage, (variable) => (variable === 'prompt' ? prompt.trim() : issues.join(' ')));
  return 'opening' in filled ? filled.opening : '';
}

// A stage's first message, its args filled by `valueOf` (`prompt`,
// `artifacts.spec`…), or the variables it has no value for.
export function fillOpening(stage: Stage, valueOf: (variable: string) => string | null): { opening: string } | { missing: string[] } {
  const missing: string[] = [];
  const args = (stage.args ?? '')
    .replace(TEMPLATE, (_, variable: string) => {
      const value = valueOf(variable);
      if (value === null) missing.push(variable);
      return value ?? '';
    })
    .trim();
  if (missing.length) return { missing };
  return { opening: stage.skill === undefined ? args : `/factory:${stage.skill}${args ? ` ${args}` : ''}` };
}

// The artifact kinds a stage's args name, such as `spec` for `{{artifacts.spec}}`.
export function artifactKindsIn(stage: Stage): string[] {
  return variablesOf(stage).flatMap((variable) => (variable.startsWith('artifacts.') ? [variable.slice('artifacts.'.length)] : []));
}

// The stage a preset starts at, and its first run's first message, or why
// the launch inputs can't start it there. `stageId` defaults to the first.
export function planStart(
  preset: ResolvedPreset,
  stageId: string | undefined,
  inputs: LaunchInputs,
): { stage: Stage; opening: string } | { error: string } {
  const stage = stageId === undefined ? preset.stages[0]! : preset.stages.find(({ id }) => id === stageId);
  if (!stage) return { error: `${preset.name} has no stage ${stageId}.` };
  const starts = startStages(preset);
  const start = starts.find(({ id }) => id === stage.id);
  if (!start) {
    return {
      error:
        `${preset.name} can’t start at ${stage.id}: its args can’t be filled from a prompt or issue refs. ` +
        `It can start at ${or(starts.map(({ id }) => id))}.`,
    };
  }
  if (start.needs.includes('prompt') && !inputs.prompt.trim()) return { error: `Starting ${preset.name} at ${stage.id} needs a prompt.` };
  if (start.needs.includes('issues') && inputs.issues.length === 0) return { error: `Starting ${preset.name} at ${stage.id} needs issue refs.` };
  return { stage, opening: openingMessage(stage, inputs) };
}

// The stages of the preset that write to GitHub as the factory's App (ADR
// 0004): its factory actions, and its AFK loops, which close each ticket
// they finish (ADR 0006). HITL stages act as the operator.
export function writingStages(preset: ResolvedPreset): string[] {
  return preset.stages.filter((stage) => stage.kind === 'action' || (stage.kind === 'loop' && stage.mode === 'AFK')).map(({ id }) => id);
}

// Why a launch of the preset is blocked where the App's installation was
// checked as `check`, or null when it isn't: only a preset with stages that
// write to GitHub (`writes`) needs the App (ADR 0004).
export function appBlock(preset: string, writes: string[], check: AppCheck | null): string | null {
  if (writes.length === 0 || !check || check.installed) return null;
  return `${preset} writes to GitHub as the factory’s App (at ${writes.join(', ')}). ${check.reason}`;
}

// A preset as a launch card offers it: the stages it can start at and those
// that write to GitHub, or why it doesn't resolve.
export type PresetChoice =
  | { name: string; source: PresetScope; description: string | null; startStages: StartStage[]; writes: string[] }
  | { name: string; source: PresetScope; error: string };

// Every preset name among `files`, by name, each as it resolves.
export function presetChoices(files: PresetFile[]): PresetChoice[] {
  return [...new Set(files.map(({ name }) => name))].sort().map((name) => {
    const result = resolvePreset(files, name);
    const { scope } = winner(files, name)!;
    if ('error' in result) return { name, source: scope, error: result.error };
    const { description } = result.preset;
    return { name, source: scope, description, startStages: startStages(result.preset), writes: writingStages(result.preset) };
  });
}

// The preset a launch in `repo` picks unless told otherwise: its configured
// default, or main-flow with a warning when that no longer resolves.
export function launchDefault(files: PresetFile[], repo: string, configured: string): { name: string; warning: string | null } {
  const result = resolvePreset(files, configured);
  if (!('error' in result) || configured === DEFAULT_PRESET) return { name: configured, warning: null };
  return {
    name: DEFAULT_PRESET,
    warning: `The default preset of ${repo}, ${configured}, no longer resolves (${result.error}), so ${DEFAULT_PRESET} is picked instead.`,
  };
}

// Issue refs as `owner/name#n`, from that form, `#n` in `repo`, or an issue URL.
export function issueRefs(refs: string[], repo: string): { issues: string[] } | { error: string } {
  const issues: string[] = [];
  for (const ref of refs) {
    const match =
      /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref) ?? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/i.exec(ref);
    if (!match) return { error: `${ref} is not an issue ref (#12, owner/name#12 or an issue URL).` };
    issues.push(`${match[1] ?? repo}#${match[2]}`);
  }
  return { issues };
}

function variablesOf(stage: Stage): string[] {
  return [...(stage.args ?? '').matchAll(TEMPLATE)].map((match) => match[1]!);
}

// The stages once every override is merged: each one whole and in the vocabulary.
function checkStages(drafts: StageDraft[]): { stages: Stage[] } | { error: string } {
  if (drafts.length === 0) return { error: 'a preset needs at least one stage.' };
  const ids = drafts.map(({ id }) => id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) return { error: `stage ${twice} appears twice.` };
  const stages: Stage[] = [];
  for (const draft of drafts) {
    const checked = stageSchema.safeParse(draft, { reportInput: true });
    if (!checked.success) return { error: `stage ${draft.id}: ${describeIssue(checked.error.issues[0]!, 'stage')}` };
    const problem = stageProblem(checked.data);
    if (problem) return { error: `stage ${draft.id}: ${problem}` };
    stages.push(checked.data);
  }
  return { stages };
}

// What the schema alone can't say is wrong with a stage, or null.
function stageProblem(stage: Stage): string | null {
  if (stage.exit !== undefined) {
    const kind = /^artifact:(.*)$/.exec(stage.exit)?.[1];
    if (kind !== undefined && !isArtifactKind(kind)) {
      return `exit ${stage.exit} names no artifact kind (${ARTIFACT_KINDS.join(', ')}).`;
    }
    if (kind === undefined && !EXITS.includes(stage.exit)) return `exit ${stage.exit} is not an exit condition (${EXITS.join(', ')}).`;
  }
  for (const [placeholder, variable] of (stage.args ?? '').matchAll(TEMPLATE)) {
    if (variable === 'prompt' || isArtifactKind(/^artifacts\.(.*)$/.exec(variable!)?.[1])) continue;
    return `args use ${placeholder}, which is not {{prompt}} or {{artifacts.<kind>}} of ${ARTIFACT_KINDS.join(', ')}.`;
  }
  if (stage.kind === 'action') {
    if (!FACTORY_ACTIONS.includes(stage.id)) return `an action stage's id names its factory action (${FACTORY_ACTIONS.join(', ')}).`;
    if (stage.skill !== undefined) return 'an action stage runs no skill.';
  }
  if (stage.kind === 'loop' && stage.skill === undefined) return 'a loop stage needs a skill.';
  if (stage.kind === 'run' && stage.skill === undefined && stage.args === undefined) return 'a run stage needs a skill or args.';
  if (stage.mode === 'HITL' && stage.autonomy !== undefined) return 'only an AFK stage has an autonomy ceiling.';
  return null;
}

function isArtifactKind(kind: string | undefined): kind is (typeof ARTIFACT_KINDS)[number] {
  return (ARTIFACT_KINDS as readonly (string | undefined)[]).includes(kind);
}

// A schema issue as a sentence. `of` says what the issue's object is.
function describeIssue(issue: z.core.$ZodIssue, of: 'stage' | 'preset'): string {
  const field = issue.path.at(-1)?.toString();
  if (issue.code === 'unrecognized_keys') return `${issue.keys.join(', ')} ${issue.keys.length === 1 ? `is not a ${of} field` : `are not ${of} fields`}.`;
  if (issue.input === undefined) return `${field} is missing.`;
  if (field === 'max_turns') return 'max_turns must be a whole number of at least 1.';
  if (issue.code === 'invalid_value') return `${field} must be ${or(issue.values.map(String))}.`;
  if (issue.code === 'invalid_type') return `${field} must be a ${issue.expected}.`;
  return field === undefined ? `${issue.message}.` : `${field}: ${issue.message}.`;
}

function or(values: string[]): string {
  return values.length > 1 ? `${values.slice(0, -1).join(', ')} or ${values.at(-1)}` : (values[0] ?? '');
}

// The preset named `name` that wins its clash, among those in scopes below
// `below` when given.
function winner(files: PresetFile[], name: string, below?: PresetScope): PresetFile | undefined {
  return files
    .filter((file) => file.name === name && (below === undefined || RANK[file.scope] < RANK[below]))
    .sort((a, b) => RANK[b.scope] - RANK[a.scope])[0];
}

// The file's stages, with those of the preset it extends merged in. `chain`
// holds the files extended so far, the file itself last.
function draftOf(
  files: PresetFile[],
  file: PresetFile,
  chain: PresetFile[],
): { stages: StageDraft[]; description: string | null } | { error: string } {
  let raw: unknown;
  try {
    raw = parse(file.content);
  } catch (error) {
    return { error: `${where(file)} isn't YAML: ${(error as Error).message}` };
  }
  const checked = documentSchema.safeParse(raw, { reportInput: true });
  if (!checked.success) return { error: `${where(file)}: ${describeDocumentIssue(checked.error.issues[0]!, raw)}` };
  const document = checked.data;
  const description = document.description ?? null;
  if (document.extends === undefined) return { stages: document.stages, description };
  // Extending its own name extends the preset it shadows.
  const parent = winner(files, document.extends, document.extends === file.name ? file.scope : undefined);
  if (!parent) return { error: `${where(file)}: it extends ${document.extends}, and there is no preset ${document.extends}.` };
  const looped = chain.indexOf(parent);
  if (looped >= 0) {
    return { error: `${where(parent)}: it extends itself through ${chain.slice(looped + 1).map((file) => file.name).join(', ')}.` };
  }
  const inherited = draftOf(files, parent, [...chain, parent]);
  if ('error' in inherited) return inherited;
  let stages = inherited.stages;
  if (document.from !== undefined) {
    const start = stages.findIndex((stage) => stage.id === document.from);
    if (start < 0) {
      return { error: `${where(file)}: it extends ${document.extends} from ${document.from}, which ${document.extends} has no stage of.` };
    }
    stages = stages.slice(start);
  }
  return { stages: merge(stages, document.stages), description: description ?? inherited.description };
}

// `own` laid over `inherited`: a stage with an inherited id overrides its
// fields, and a new one goes before the next stage `own` overrides, or last.
function merge(inherited: StageDraft[], own: StageDraft[]): StageDraft[] {
  const stages = [...inherited];
  let pending: StageDraft[] = [];
  for (const stage of own) {
    const at = stages.findIndex(({ id }) => id === stage.id);
    if (at < 0) {
      pending.push(stage);
      continue;
    }
    stages.splice(at, 1, ...pending, { ...stages[at]!, ...stage });
    pending = [];
  }
  return [...stages, ...pending];
}

// A preset file's schema issue as a sentence, about one of its stages when
// the issue is.
function describeDocumentIssue(issue: z.core.$ZodIssue, raw: unknown): string {
  const [key, index] = issue.path;
  if (key === 'stages' && typeof index === 'number') {
    const id = (raw as { stages: { id?: unknown }[] }).stages[index]?.id;
    const stage = typeof id === 'string' ? id : String(index + 1);
    return `stage ${stage}: ${describeIssue({ ...issue, path: issue.path.slice(2) }, 'stage')}`;
  }
  if (key === 'stages' && issue.code === 'invalid_type') return 'stages must be a list of stages.';
  if (issue.path.length === 0 && issue.code === 'invalid_type') return 'a preset is a mapping of preset fields.';
  return describeIssue(issue, 'preset');
}

function where(file: PresetFile): string {
  return `Preset ${file.name} (${file.scope}, ${file.path})`;
}

const BUILT_IN = fileURLToPath(new URL('./built-in/', import.meta.url));

// The presets the factory ships.
export function builtInPresets(): PresetFile[] {
  return presetFiles(
    'built-in',
    readdirSync(BUILT_IN).map((file) => ({ path: `built-in/${file}`, content: readFileSync(BUILT_IN + file, 'utf8') })),
  );
}

// The operator's presets, in `dir` (`~/.agent-factory/presets/`), if any.
export function userPresets(dir: string): PresetFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return presetFiles(
    'user',
    names.filter((name) => name.endsWith(PRESET_SUFFIX)).map((name) => ({ path: join(dir, name), content: readFileSync(join(dir, name), 'utf8') })),
  );
}

const PRESET_SUFFIX = '.preset.yaml';

// Where a repository keeps its presets, read from `origin/<base_branch>`.
export const REPO_PRESETS = '.agent-factory/presets';

// The preset files among `files`, named after them.
export function presetFiles(scope: PresetScope, files: { path: string; content: string }[]): PresetFile[] {
  return files.flatMap(({ path, content }) => {
    const name = /(?:^|[\\/])([^\\/]+)\.preset\.yaml$/.exec(path)?.[1];
    return name ? [{ scope, name, path, content }] : [];
  });
}
