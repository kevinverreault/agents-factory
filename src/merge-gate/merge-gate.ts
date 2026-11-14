// The merge gate's configuration (ADR 0014): what an agent policy's gate
// goes by, owned by the operator and never by the repository it gates. It
// resolves in three layers, each overriding the one before field by field:
// the built-in defaults below, the operator's optional `merge-gate.yaml` in
// the factory home, and that file's section for the task's repository. A
// task freezes the result at its handoff, or at launch when it starts AFK.
import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

// How the factory merges a PR on GitHub.
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

// The tripwires that aren't path globs, a fixed vocabulary evaluated without
// a model: a dependency added or upgraded (a manifest change beyond the
// lockfile), tests deleted or skipped, and a high-severity finding left
// after fix-once.
export const TRIPWIRE_PREDICATES = ['dependency-change', 'tests-removed-or-skipped', 'high-severity-finding'] as const;
export type TripwirePredicate = (typeof TRIPWIRE_PREDICATES)[number];

// The resolved config, as a task freezes it. `tripwires.paths` are globs of
// the files whose touching sends a semi-auto PR to the operator, and
// `rubric` the lines its judging run sends one to the operator by.
export type MergeGateConfig = {
  tripwires: { paths: string[]; predicates: TripwirePredicate[] };
  rubric: string[];
  mergeMethod: MergeMethod;
};

// There is no diff-size tripwire: a large PR is no risk in itself.
export const DEFAULT_MERGE_GATE: MergeGateConfig = {
  tripwires: {
    paths: ['**/migrations/**', '.github/**', 'docs/adr/**', '**/Dockerfile', '**/Dockerfile.*', '**/*.tf'],
    predicates: [...TRIPWIRE_PREDICATES],
  },
  rubric: [
    'The PR goes beyond or short of the ticket’s done-when.',
    'It changes behaviour or an interface others rely on in a way the spec doesn’t say.',
    'It touches security-sensitive code: auth, secrets, crypto, permissions, the factory’s own guards.',
    'It settled an ambiguity by an assumption the operator might not share.',
    'It is irreversible once deployed: data deletion, schema, published formats.',
  ],
  mergeMethod: 'merge',
};

// The fields a layer may override, as the file names them; the file itself
// also has `repositories`, each section a layer of these.
const FIELDS = ['tripwires', 'rubric', 'merge_method'] as const;
// A list of lines, none blank.
const strings = z.array(z.string().trim().min(1));
const layerFields = {
  tripwires: z.strictObject({ paths: strings.optional(), predicates: z.array(z.enum(TRIPWIRE_PREDICATES)).optional() }).optional(),
  rubric: strings.optional(),
  merge_method: z.enum(MERGE_METHODS).optional(),
};
const layerSchema = z.strictObject(layerFields);
// One layer as the file writes it: the user file's own fields, or a repository's section.
type Layer = z.infer<typeof layerSchema>;
// A repository section is named owner/name.
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fileSchema = z.strictObject({
  ...layerFields,
  repositories: z.record(z.string().regex(REPOSITORY), layerSchema).optional(),
});

// The operator's file as read, `path` saying where, for refusals.
export type MergeGateFile = { path: string; content: string };

// The config resolved, and the name of the repository section laid over the
// user file, if one was.
export type ResolvedMergeGateConfig = { config: MergeGateConfig; section: string | null };

// The config for `repo` (none: the user file alone), from the operator's
// file, if there is one. An invalid file is refused whole, even when only
// another repository's section is wrong. Sections are matched whatever
// their names' case, as GitHub names repositories, so two that differ only
// by case are refused.
export function resolveMergeGateConfig(file: MergeGateFile | null, repo: string | null): ResolvedMergeGateConfig | { error: string } {
  if (!file) return { config: structuredClone(DEFAULT_MERGE_GATE), section: null };
  let raw: unknown;
  try {
    raw = parse(file.content);
  } catch (error) {
    return { error: `The merge gate config at ${file.path} isn’t YAML: ${(error as Error).message}` };
  }
  // An empty file, or one of comments alone, overrides nothing.
  raw ??= {};
  const checked = fileSchema.safeParse(raw, { reportInput: true });
  if (!checked.success) return { error: `The merge gate config at ${file.path} is invalid: ${describeIssue(checked.error.issues[0]!)}` };
  const { repositories = {}, ...user } = checked.data;
  const names = Object.keys(repositories);
  const clash = names.find((name, at) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== at);
  if (clash) return { error: `The merge gate config at ${file.path} is invalid: repositories.${clash} names the same repository as another section, in another case.` };
  const section = repo === null ? undefined : names.find((name) => name.toLowerCase() === repo.toLowerCase());
  return { config: [user, section ? repositories[section]! : {}].reduce(overlay, structuredClone(DEFAULT_MERGE_GATE)), section: section ?? null };
}

// Reads the operator's file at `path` (none there: the defaults) and
// resolves it for `repo`. Nothing is ever read from the repository itself.
export function readMergeGateConfig(path: string, repo: string | null): ResolvedMergeGateConfig | { error: string } {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolveMergeGateConfig(null, repo);
    return { error: `The merge gate config at ${path} can’t be read: ${(error as Error).message}` };
  }
  return resolveMergeGateConfig({ path, content }, repo);
}

// The config as YAML, in the file's own field names, as `agents-factory
// merge-gate` prints it.
export function mergeGateYaml(config: MergeGateConfig): string {
  return stringify({ tripwires: config.tripwires, rubric: config.rubric, merge_method: config.mergeMethod }, { lineWidth: 0 });
}

// `layer` laid over `config`: each field it names replaces the one before, lists whole.
function overlay(config: MergeGateConfig, layer: Layer): MergeGateConfig {
  return {
    tripwires: { ...config.tripwires, ...layer.tripwires },
    rubric: layer.rubric ?? config.rubric,
    mergeMethod: layer.merge_method ?? config.mergeMethod,
  };
}

// Words as a list ending in `or`.
const or = (words: readonly string[]) => `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;

// A schema issue as a sentence about the field it is on.
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String);
  const field = path.join('.');
  if (issue.code === 'unrecognized_keys') {
    const key = issue.keys[0]!;
    const at = [...path, key].join('.');
    if (path.length === 0) return `${key} is not a merge gate field (${[...FIELDS, 'repositories'].join(', ')}).`;
    if (path.at(-1) === 'tripwires') return `${at} is not a tripwire field (paths, predicates).`;
    return `${at} is not a merge gate field (${FIELDS.join(', ')}).`;
  }
  if (issue.code === 'invalid_key') return `${[...path].join('.')} is not a repository: name it owner/name.`;
  if (issue.code === 'invalid_value') return `${field} must be ${or(issue.values.map(String))}, not ${String(issue.input)}.`;
  if (issue.code === 'too_small') return `${field} must not be empty.`;
  if (issue.code === 'invalid_type' && path.length === 0) return 'it must be a mapping of merge gate fields.';
  if (issue.code === 'invalid_type' && issue.expected === 'array') return `${field} must be a list of strings.`;
  if (issue.code === 'invalid_type' && issue.expected === 'object') return `${field} must be a mapping.`;
  return `${field}: ${issue.message}`;
}
