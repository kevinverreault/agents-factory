// The Lifecycle: repositories, tasks, runs and attention requests as a pure
// reducer with guards and selectors. Every operator command and every run event goes
// through `reduce`. Ported from the task-lifecycle prototype, amended by
// ADR 0003 (`interrupted`) and ADR 0008 (no usage-window stop, no budget).
// A launched task freezes its workflow preset, starts at one of its stages,
// advances across HITL boundaries on the operator's confirm and across AFK
// ones on its own, and works a map's tickets with the operator at a work
// loop (ADR 0012); child tasks arrive with their own slice.
import { DEFAULT_TIER, isTier, route, TIERS, type Routes, type Tier } from '../models/routing.ts';
import { issueRef } from '../artifacts/capture.ts';
import type { Checks, ChecksState, FailedCheck, Issue, Mergeability, Permission as AppPermission, Permissions, PrState, PullRequest } from '../github/github.ts';
import { researchNameRefusal } from '../github/research-branch.ts';
import { artifactKindsIn, fillOpening, isRetiredLoop, isWorkLoop, TREE_LIMITS, type LaunchInputs, type ResolvedPreset, type Stage, type TreeLimits } from '../presets/presets.ts';
import { callWithRule, isRule, patternFor, ruleFor, uncovered, type ToolCall } from '../permissions/permissions.ts';
import { cutToFit, oneLineOf } from '../text/lines.ts';
import { SETUP_PRESET } from '../skills/repo-setup.ts';
import {
  correction,
  grown,
  merged,
  NO_USAGE,
  overall,
  plus,
  resetTime,
  weeklySpentUntil,
  tokensOf,
  updatedSnapshot,
  type ModelUsage,
  type Usage,
  type UsageSnapshots,
  type UsageWindowKind,
  type UsageWindowStatus,
} from '../usage/usage.ts';

export type Mode = 'HITL' | 'AFK';
// An autonomy level (ADR 0007): L1 runs on the operator's machine, L2 in the
// task's own container and publishes its code, and L3 runs as L2 does and
// may also merge the task's PR into the base branch (ADR 0014).
export type AutonomyLevel = 'L1' | 'L2' | 'L3';
// The operator's priority for an AFK task: urgent ones take a free slot first.
export type Priority = 'normal' | 'urgent';

export type TaskState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting' /* Needs you */
  | 'awaiting-children'
  | 'in-review'
  | 'done'
  | 'cancelled';
export type RunStatus = 'active' | 'suspended' | 'ended';
export type RunOutcome =
  | 'completed'
  | 'handed off'
  | 'taken over'
  | 'failed'
  | 'waiting on children'
  | 'parked'
  | 'cancelled'
  | 'interrupted';
export type Interruption = 'graceful' | 'unclean';
export type Turn = 'agent' | 'operator';

// What the agent asked through `AskUserQuestion`: in a HITL run a card in the
// conversation, in an AFK run a `question` attention request. `id` is the
// tool use's.
export type Question = {
  id: string;
  questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }[];
};
// The tool call a `permission` request asks about (ADR 0007): `id` is the
// tool use's, and `rule` the call's own, which Allow once allows. `proposed`
// holds what Allow for this task and Allow always propose for the parts no
// rule covers. Requests stored before it have none, and propose `rule`.
export type Permission = { id: string; tool: string; summary: string; rule: string; proposed?: ProposedRule[] };
// A pattern proposed for a part of a call no rule covers, with that part's
// summary. Parts that get the same pattern share one, under the first.
export type ProposedRule = { part: string; rule: string };
// How the operator answers a permission request: allow the call once; allow
// it, and the calls `rules` cover, for the rest of the task or always (see
// `RulesAnswer`); or deny it with a note the agent reads.
export type PermissionAnswer = { allow: 'once' } | RulesAnswer | { deny: string };
// An answer that allows by rules, the request's proposed ones if `rules` is
// absent: the task's for the rest of it, or, always, the operator's
// permissions file's, which the daemon adds them to, for every task.
export type RulesAnswer = { allow: 'task' | 'always'; rules?: string[] };
// Each question's text with its answer: an option's label (a multi-select's
// labels joined by ", "), or the operator's own words.
export type Answers = Record<string, string>;
export type AttentionKind =
  | 'question'
  | 'permission'
  | 'failure'
  | 'stage-blocked'
  | 'github-write'
  | 'pr-closed-unmerged'
  | 'repo-missing'
  | 'recovery-report';
export type AttentionStatus = 'open' | 'answered' | 'superseded' | 'closed';

// The agent's proposal to advance the task to its next stage
// (`propose_advance`) or hand it off (`propose_handoff`), shown until the
// operator acts on it or keeps talking instead.
export type Proposal = { kind: 'advance' | 'handoff'; reason: string };

// The handoff brief: what the HITL run agreed with the operator, which the
// AFK run starts from. `links` are issue refs, file paths or URLs.
export type Brief = { goal: string; decided: string[]; doneWhen: string[]; outOfScope: string[]; links: string[] };
// Whether a handoff's AFK run resumes the conversation or starts a fresh
// session from the brief alone.
export type ContinueAs = 'resume' | 'fresh';
export const CONTINUE_AS: readonly ContinueAs[] = ['resume', 'fresh'];
// How the task's worktree stands for a handoff: why it can't be confirmed
// yet, and the files the handoff commit takes.
export type Readiness = { blockers: string[]; toCommit: string[] };
// The handoff sheet, open on a HITL task from the operator's handoff until
// they confirm it or back out. Its fields are pre-filled from the AFK stage
// it hands off to; what the operator changes travels with the confirm.
export type HandoffSheet = {
  // The brief the HITL run wrote, or null while it hasn't yet.
  brief: Brief | null;
  // Whether a run was asked for the brief: an agent mid-turn is asked only
  // once its interrupted turn has ended.
  asked: boolean;
  // The AFK stage the handoff starts, or null when the task has none ahead.
  stage: string | null;
  continueAs: ContinueAs;
  autonomy: AutonomyLevel;
  // Sheets stored before merge policies have none: `operator`.
  mergePolicy?: MergePolicy;
  tier: Tier;
  maxTurns: number;
  // The share of the context window the conversation fills, when known.
  contextShare: number | null;
  readiness: Readiness;
  // The spec candidates the factory found for a handoff to a stage that
  // launches ticket tasks (ADR 0013), or null for one to any other stage.
  // Sheets stored before ticket sets have none.
  ticketSets?: HandoffTicketSets | null;
};

// A spec candidate of a handoff (ADR 0013): an issue the task recorded, at
// any stage, that has sub-issues, which are its tickets, in their order.
export type SpecCandidate = { spec: string; title: string; tickets: Issue[] };

// The spec candidates the handoff sheet offers, as the factory read them
// from GitHub when it opened, and why it couldn't read them, if it couldn't.
// `withoutTickets` are the issues the task recorded with no sub-issues that
// are no candidate's ticket: tickets linked to one only by text ("Part of
// #n") leave it here, with 0 tickets.
// `selected` is the candidate the sheet starts selected: the issue recorded
// at a stage whose exit is `artifact:spec`, else the one recorded last.
export type HandoffTicketSets = { candidates: SpecCandidate[]; selected: string | null; withoutTickets: { ref: string; title: string }[]; problem: string | null };
// A quick launch's grill, while it lasts (`n`): the questions the operator
// has answered so far, of at most QUICK_QUESTIONS, and whether the grill is
// `done`, so the factory opens its handoff sheet: once a turn of it ends on
// the operator's, or it asks past its questions. It ends once its handoff
// sheet opens, or once the operator expands it into a full conversation.
export type QuickLaunch = { questions: number; done: boolean };
// How much of its model's context window a session fills, as its latest turn left it.
export type ContextUse = { used: number; window: number };

// A root task's task branch and the worktree it is checked out in (ADR 0010).
export type TaskWorktree = { branch: string; path: string };

// A HITL task's work loop over a map at its loop stage (wayfinder, ADR 0012).
export type Loop = {
  // `pick` while the factory reads the map, null otherwise.
  step: 'pick' | null;
  // The ticket of the map the operator works now, if any.
  ticket: string | null;
  // Between its tickets the loop waits on the operator: `frontier` is what
  // the map offered when last read (its open tickets with no open blockers,
  // in sub-issue order), for them to pick from, with the session the picked
  // ticket starts; `cleared` is true once the map had no open tickets, for
  // them to choose where the task goes.
  frontier?: FrontierTicket[] | null;
  session?: string | null;
  cleared?: boolean;
};
// A ticket on a map's frontier, by its ref and title.
export type FrontierTicket = { ref: string; title: string };

// An ended task's cleanup while it hasn't finished (ADR 0011): why it last
// failed, if it did, whether its local task branch stays, as Keep branch
// leaves it, and what goes on GitHub. Cleanups stored before Cancel cleaned
// up delete it.
export type Cleanup = { problem: string | null; keepBranch?: boolean; remote?: RemoteCleanup | null };
// What a root the factory published leaves on GitHub once it ends: its
// remote task branch, which the factory deletes as its App, and, once
// cancelled, the number of its PR, which it closes first with a comment.
export type RemoteCleanup = { branch: string; prToClose: number | null };
// What Cancel does with a task branch holding commits that exist nowhere
// else: Keep branch (the default) or Discard work.
export type BranchChoice = 'keep' | 'discard';
export const BRANCH_CHOICES: readonly BranchChoice[] = ['keep', 'discard'];

// What a child task hands its parent when it ends (ADR 0009): the agent's
// summary, status and notes through `report_result` (else its final result
// text as the summary), and the facts the factory holds: its branch, the
// commits it made there and how its last run ended.
export type ChildReport = {
  summary: string;
  status: string;
  notes: string;
  branch: string;
  commits: string[];
  outcome: RunOutcome | null;
};

// A child task's place in its tree (ADR 0009): how deep it is (the root's
// children are 1), the run that spawned it and that run's tool call, which
// a replay of the spawn finds it by, whether its parent waits for it, the
// commit its branch was cut from, and its report, once it has one.
export type Child = {
  depth: number;
  spawnedBy: { runId: string; toolUseId: string };
  awaited: boolean;
  base: string;
  report: ChildReport | null;
  // What the agent reported through `report_result`, until the child ends
  // and it becomes part of `report`.
  agentReport?: Pick<ChildReport, 'summary' | 'status' | 'notes'> | null;
  // True once a run of its parent that opened on an awaited child's report
  // started: its parent waits for it no longer.
  delivered?: boolean;
  // True once its local branch is gone: deleted with its worktree, merged
  // into its parent's branch, or with its tree once the root ended (ADR 0011).
  branchDeleted?: boolean;
  // A research child's ticket, and where publishing its findings stands.
  // Children stored before research children have none.
  research?: Research | null;
};

// A wayfinder research child's ticket (ADR 0007), `owner/name#n`, and,
// once it reported, the factory's next step for it: pushing its
// `research/<name>` branch, then closing the ticket, null once both are
// done. `problem` is why the step last failed, until the operator answers.
// `refusalNoted` is true once its parent heard its push was refused.
export type Research = { ticket: string; step: 'push' | 'close' | null; problem: string | null; refusalNoted?: boolean };

// A root's Push & open draft PR while it hasn't finished (ADR 0007): the
// step the factory is on, pushing the task branch or opening its draft PR
// (skipped once it has one), and why that step last failed, if it did. A
// failed step is tried again once the operator answers the request it raised.
// A setup task's publishing (ADR 0010) starts by committing the setup
// files its runs left uncommitted in the worktree.
export type Publishing = { step: 'commit' | 'push' | 'open-pr'; problem: string | null };

// What a `fix-once` review stage's runs found, whether its one fix pass
// has begun, and what is left over: everything found, until the fix pass
// reports what it left unfixed.
export type Findings = { found: string[]; fixPass: boolean; leftOver: string[] };

// What a root task is (ADR 0013): a plain root, a spec task that launches
// ticket tasks over its spec's tickets, or a ticket task working one ticket
// into its own PR. Tasks stored before kinds are plain roots.
export type TaskKind = 'plain' | 'spec' | 'ticket';
// Who passes an AFK root task's merge gate (ADR 0013, ADR 0014): under
// `operator` the task goes In review and the operator merges its PR; under
// `judged` (semi-auto) the factory merges unless its gate check sends the PR
// to the operator; under `unattended` (full-auto) the factory merges every PR
// whose checks pass. The two agent policies need L3.
export type MergePolicy = 'operator' | 'judged' | 'unattended';
// Every merge policy, as a refusal names them.
export const MERGE_POLICIES: readonly MergePolicy[] = ['operator', 'judged', 'unattended'];
// Those the handoff sheet and the launch card offer: `judged` waits on its
// gate check, which the factory can't run yet.
export const OFFERED_POLICIES: readonly MergePolicy[] = ['operator', 'unattended'];
// Each policy as the TUI names it: never `auto` alone, which is Claude
// Code's permission mode.
export const POLICY_NAMES: Record<MergePolicy, string> = { operator: 'operator', judged: 'semi-auto', unattended: 'full-auto' };

// The merge policy a task, handoff sheet, launch or handoff goes by:
// `operator` where it names none, as those stored before merge policies,
// or a launch and a handoff that left it out.
export function policyOf(holder: { mergePolicy?: MergePolicy | null } | null | undefined): MergePolicy {
  return holder?.mergePolicy ?? 'operator';
}

// Where an agent policy's merge gate stands (ADR 0014), as the PR poll last
// read it: the combined checks on the PR's `head`, and, once they let it
// through, the factory's step on GitHub: marking the draft ready, then
// merging it. `problem` is why a step last failed, until the operator
// answers the github-write request it raised: the step is dropped, and the
// gate is read afresh before it is taken again.
export type MergeGate = { checks: ChecksState; head: string; step: MergeStep | null; problem: string | null };
// A step of the factory's merge, in order: marking the draft PR ready, then merging it.
export type MergeStep = 'ready' | 'merge';
export const MERGE_STEPS: readonly MergeStep[] = ['ready', 'merge'];
// The event that says each step is done.
export const MERGE_STEP_DONE = { ready: 'prMarkedReady', merge: 'prMerged' } as const satisfies Record<MergeStep, string>;

// A root's fix run on its PR's red checks (ADR 0014): `redHead` is the head
// whose checks queued it, and `pushed` the commit the factory pushed once it
// ended, if it has. A read still giving `redHead` after a push of something
// newer is GitHub not caught up yet, and waits for the next read.
export type FixRun = { redHead: string; pushed: string | null };

// A wayfinder task's maps the factory owes their closing (ADR 0013), as
// its App, and why it last couldn't. `spec` is the spec written from them,
// which closed, or null once the task ended at its cleared map. It is tried
// again at the next PR poll, or by the next daemon. The factory never
// touches a map's decision tickets (ADR 0012).
export type MapClosing = { maps: string[]; spec: string | null; problem: string | null };

// A ticket task's merged PR left its ticket open (ADR 0013): the factory
// closes it as its App, and `problem` is why it last couldn't. It is tried
// again at the next PR poll, or by the next daemon.
export type TicketResolution = { problem: string | null };

// A spec task's ticket set (ADR 0013): the spec whose sub-issues its
// tickets are, or null when the launch named the tickets themselves, and
// those tickets in sub-issue (or launch) order. `reading` is true while the
// factory owes a read of them from GitHub, `issues` is what it last read,
// and `toLaunch` the frontier tickets of that read it hasn't launched a
// ticket task for yet, in frontier order. `launched` maps each launched
// ticket to its ticket task. `problem` is why the factory last couldn't
// read the tickets or launch one: it tries again at the next PR poll.
// `skipped` are the tickets whose ticket task the operator cancelled, which
// it doesn't launch again. `reads` counts the reads owed so far: a read the
// daemon started before the last one was owed leaves the next still owed.
// Once no ticket is open, `closing` holds while the factory owes the spec
// its closing (`anyway` once the operator closes it with tickets left
// open), and `closed` once it is closed (or the set has no spec).
export type TicketSet = {
  spec: string | null;
  tickets: string[];
  reading: boolean;
  reads?: number;
  closing?: (TicketResolution & { anyway?: boolean }) | null;
  closed?: boolean;
  issues: Issue[];
  toLaunch: string[];
  launched: Record<string, string>;
  skipped?: string[];
  problem: string | null;
};

// How the operator ends a spec task left with skipped tickets: leaving its
// spec open, or closing it anyway.
export type SpecEnd = 'spec-open' | 'close-spec';
export const SPEC_ENDS: readonly SpecEnd[] = ['spec-open', 'close-spec'];

// The label of the tickets a spec task launches AFK ticket tasks on.
export const READY_FOR_AGENT = 'ready-for-agent';
// The label of the tickets a spec task launches HITL ticket tasks on.
export const READY_FOR_HUMAN = 'ready-for-human';

// The mode of the ticket task a spec task launches on the ticket, by its
// label (ADR 0013): AFK for ready-for-agent, HITL for ready-for-human, and
// null for any other label, or none: the ticket is held back.
export function ticketMode({ labels }: Pick<Issue, 'labels'>): Mode | null {
  if (labels.includes(READY_FOR_AGENT)) return 'AFK';
  return labels.includes(READY_FOR_HUMAN) ? 'HITL' : null;
}

// Whether the ticket is open and held back by its label: its spec task
// never launches it until it is relabelled.
export function heldBack(issue: Pick<Issue, 'open' | 'labels'>): boolean {
  return issue.open && ticketMode(issue) === null;
}

// A held-back ticket as the operator is told of it: its ref (as `refOf`
// shortens it) with its labels, or that it has none.
export function heldBackLabel({ ref, labels }: Pick<Issue, 'ref' | 'labels'>, refOf = (ref: string) => ref): string {
  return `${refOf(ref)} (${labels.join(', ') || 'no label'})`;
}

// Whether a spec task would launch a ticket task on the ticket now, had it
// not already (ADR 0013): open, with no open blockers, and not held back.
export function readyNow(issue: Issue): boolean {
  return issue.open && issue.openBlockers.length === 0 && ticketMode(issue) !== null;
}

// The workflow preset a task froze at launch, with the commit of
// `origin/<base_branch>` its repo-scope presets were read from: editing a
// preset file later never changes it.
export type FrozenPreset = ResolvedPreset & { repoCommit: string };

export type Task = {
  id: string;
  title: string;
  // The repository the task works in, fixed at launch.
  repo: string;
  // The task that spawned it, for a child task: cancelling a task cancels
  // its whole subtree. Roots, and tasks stored before children, have none.
  parent?: string | null;
  // What kind of root it is, its ticket for a ticket task, and the merge
  // policy its merge gate goes by (ADR 0013). Children, and tasks stored
  // before kinds, are plain.
  kind?: TaskKind;
  ticket?: string | null;
  // Frozen at launch for a task starting AFK, or at its handoff (ADR 0014),
  // and inherited by a spec task's ticket tasks.
  mergePolicy?: MergePolicy | null;
  // Its merge gate, while it waits there under an agent policy.
  gate?: MergeGate | null;
  // While the factory still owes the ticket of a ticket task whose PR merged
  // its closing, once GitHub left it open.
  resolving?: TicketResolution | null;
  // The spec task that launched it, for a ticket task it launched.
  specTask?: string | null;
  // A spec task's ticket set.
  ticketSet?: TicketSet | null;
  // While the factory still owes a wayfinder task's maps their closing
  // (ADR 0013): once the spec written from them closed, or once the task
  // ended at its cleared map.
  mapClosing?: MapClosing | null;
  // Its place in its tree, for a child task.
  child?: Child | null;
  // The one-line progress its agent last set through `report_progress`,
  // while the task is unfinished.
  progress?: string | null;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  groups: string[];
  // Tasks stored before priorities are normal.
  priority?: Priority;
  // The operator's max turns for its AFK runs, over each stage's
  // `max_turns`; null when they set none.
  maxTurns?: number | null;
  // Its first run's first message: for a launched task, its start stage's
  // skill invoked on the launch inputs.
  goal: string | null;
  // The tier the operator picked, at launch or by re-tiering it, over every
  // stage's; null when they picked none.
  operatorTier?: Tier | null;
  // The task branch and its worktree, cut at launch.
  worktree: TaskWorktree | null;
  // The skill set version frozen at launch (ADR 0005): every run loads it.
  skillSet: string | null;
  // The preset frozen at launch, and the id of the stage the task is at.
  // Tasks created without a launch, or stored before presets, have none.
  preset?: FrozenPreset | null;
  stage?: string | null;
  // What it launched with: for later stages' args, the prompt and the issue
  // refs with the artifact kinds they stand for (those its start stage's args
  // name). Tasks stored before `operatorTier` keep the operator's launch
  // tier here.
  inputs?: LaunchInputs & { issueKinds: string[]; tier?: Tier | null };
  // The tier the delegating agent chose for a child, clamped to its own
  // run's, under the operator's and over the stage's (ADR 0009).
  delegatedTier?: Tier | null;
  sessionId: string | null;
  // True while its next run starts the session `sessionId` names rather
  // than resuming it, as a fresh-context stage's first run does.
  newSession?: boolean;
  runIds: string[];
  state: TaskState;
  createdAt: number;
  // Its place in the order tasks last became Queued in: first in, first out
  // goes by it. Tasks stored before it go first.
  queuePlace?: number;
  // What its next AFK run opens on instead of carrying on, such as the
  // answers to a question its parked run asked.
  resumeWith?: string | null;
  // The factory notes a HITL task holds for its conversation (ADR 0009):
  // its fire-and-forget children's reports, delivered on the operator's
  // turn, or in its next run's opening once it was parked.
  factoryNotes?: string[];
  // The rules the operator allowed for this task (ADR 0007): its L1 runs
  // make calls they cover without asking. Tasks stored before them have none.
  allowRules?: string[];
  // The rules the operator allowed once while its run was parked, which its
  // next run takes.
  allowOnce?: string[];
  // The hosts the operator allowed this task's L2 runs to reach, besides the
  // built-in ones (ADR 0007). Tasks stored before them have none.
  egressHosts?: string[];
  // Its open handoff sheet, if any. Tasks stored before handoffs have none.
  handoff?: HandoffSheet | null;
  // The sheet a stop found open, unconfirmed: the next one opens from it.
  handoffDraft?: HandoffDraft | null;
  // Its quick launch, while its grill is one. Tasks stored before quick launches have none.
  quick?: QuickLaunch | null;
  // How much of the context window its session fills, once a turn said.
  context?: ContextUse | null;
  // The handoff brief it was handed off with, if any.
  brief?: string | null;
  // Its work loop while it is at a HITL loop stage over a map.
  loop?: Loop | null;
  // Its review's findings, once a `fix-once` review stage's run reported
  // some. They live on the task, so a run parked meanwhile loses none.
  findings?: Findings | null;
  // The PR body, once its `artifact:pr-body` stage wrote it: the agent's
  // text with what the factory adds.
  prBody?: string | null;
  // The PR title its `artifact:pr-body` stage wrote with the body, if any:
  // without one, the PR takes the task's title.
  prTitle?: string | null;
  // Its launch summary: what it was launched to do, as the cheap run that
  // named it summarised it, if it did. The PR body without a written one or a brief.
  launchSummary?: string | null;
  // True once the operator requested changes on it in review: past its last
  // stage, each of its runs that completes puts it back In review.
  changesRequested?: boolean;
  // True once a PR poll found a ticket task's PR conflicting with its base
  // and queued its update run (ADR 0013), until a poll finds it mergeable:
  // no other update run is queued meanwhile. Like changes requested, each
  // of its runs that completes puts it back In review.
  conflicted?: boolean;
  // Its one fix run (ADR 0014), once a PR poll found the checks on the PR
  // of a root at its merge gate red and queued it, until a poll finds them
  // green or the operator takes the task over: checks red again then raise
  // a failure request instead. Like conflicted, each of its runs that
  // completes puts it back at its gate.
  fixRun?: FixRun | null;
  // Its Push & open draft PR while under way, and the draft PR it opened.
  publishing?: Publishing | null;
  pr?: PullRequest | null;
  // True once the factory pushed the task branch, until a run starts and may
  // commit to it again: the PR has all its work, so there is nothing to push.
  pushed?: boolean;
  // True once the factory pushed the task branch to GitHub at all: its
  // cleanup deletes the branch there.
  branchOnGitHub?: boolean;
  // While its cleanup (ADR 0011), once it ended Done or Cancelled, hasn't
  // finished. It is tried again when the daemon next starts.
  cleanup?: Cleanup | null;
  // Where its session transcripts were archived once it ended: its
  // conversation is read from there.
  transcripts?: string | null;
  // How many unclean daemon starts in a row found its run active, until one
  // of its runs ends other than interrupted (ADR 0003's crash-loop guard).
  uncleanStarts?: number;
};

export type Run = {
  id: string;
  taskId: string;
  mode: Mode;
  autonomy: AutonomyLevel | null;
  status: RunStatus;
  outcome: RunOutcome | null;
  interruption: Interruption | null;
  resumesSession: boolean;
  // The session it works in. Runs stored before it have their task's.
  sessionId?: string;
  // Whose turn the conversation is on. A run starts on the agent's turn when
  // it has a first message to answer.
  turn: Turn;
  // The operator's messages sent during the agent's turn, delivered when it ends.
  queued: string[];
  // The card the agent's turn waits on, if any.
  question: Question | null;
  // A HITL run's permission card: the tool call no rule covers, which waits
  // on the operator's answer in the conversation. Runs stored before it have none.
  permission?: Permission | null;
  // The stage of its task's preset the run works on, if the task has one.
  stage: string | null;
  // The ticket it works on, as a ticket task's run (ADR 0013). Runs stored
  // before ticket tasks have none.
  ticket?: string | null;
  // The message the run starts with, or null to wait for the operator's.
  opening: string | null;
  // The awaited children whose reports its opening carries: handed over
  // once it started. Runs stored before awaited children have none.
  reports?: string[];
  proposal: Proposal | null;
  // The tier it started at, and the exact model: routed from that tier at
  // start, then the one the CLI reports it runs. Runs stored before tiers
  // were recorded have only the model.
  tier?: Tier;
  model: string;
  // An AFK run's runaway guard (ADR 0008): hitting it fails the run. HITL
  // runs have none, and neither do runs stored before it.
  maxTurns?: number | null;
  // The CLI process the daemon spawned for the run, once it is up (ADR 0003).
  cli: { pid: number; createdAt: number } | null;
  // The skill set version the run loaded: its task's.
  skillSet: string | null;
  // While the run waits on the operator, when it parks if they still haven't
  // replied: a wall-clock deadline, persisted with the run (ADR 0003).
  parksAt: number | null;
  // The rules the operator allowed once for it: each lets one call with that
  // rule through. Runs stored before them have none.
  allowOnce?: string[];
  // The hosts its container's egress proxy denied it, for an L2 run that
  // ended (ADR 0007). Runs stored before them have none.
  deniedHosts?: string[];
  // What it used, per model (ADR 0008): its API messages as they streamed,
  // brought into line by its session's totals. Runs stored before metering
  // have none.
  usage?: ModelUsage;
  // While it is live, what each of its API messages since its session's
  // last total was counted at, by message id; null once it ended.
  countedMessages?: Record<string, Usage> | null;
  // While an AFK run waits out a 5-hour usage limit in place (ADR 0008),
  // when its wait ends, in ms; null once it goes on, or ended. Runs stored
  // before it have none.
  waitingForWindow?: number | null;
  startedAt: number;
  endedAt: number | null;
};

// One minute of a run's usage (ADR 0008), from `minute` (its start, in ms):
// its records' growth in that minute, corrections included.
export type UsageSample = { id: string; runId: string; minute: number; models: ModelUsage };

export type AttentionRequest = {
  id: string;
  // The repository it is about, or null for one about the factory itself
  // (`recovery-report`).
  repo: string | null;
  // The task and run it is about, or null for a request about the repository
  // itself (`repo-missing`) or the factory.
  taskId: string | null;
  runId: string | null;
  kind: AttentionKind;
  status: AttentionStatus;
  // True while the request keeps its run suspended; false once the run ended.
  holdsRun: boolean;
  reason: string | null;
  // What a `question` request asks. Requests stored before it have none.
  question?: Question | null;
  // The call a `permission` request asks about. Requests stored before it have none.
  permission?: Permission | null;
  // What a `recovery-report` says recovery did.
  recovery?: Recovery | null;
  // The hosts a failed L2 run was denied egress to (ADR 0007), which the
  // operator can allow for the task and retry. Requests stored before them have none.
  deniedHosts?: string[] | null;
  // The skipped tickets a spec task's request offers to relaunch, once it
  // can launch no more tickets (ADR 0013). Other requests have none.
  skipped?: string[] | null;
  raisedAt: number;
};

// What recovery did with the runs an unclean start found live (ADR 0003):
// those it requeued as interrupted, those it parked, and those the
// crash-loop guard failed; and the intents it replayed first. Reports
// stored before intents were journaled have none. `found` is what it found
// that no live task has, when it found any: it deletes none of it.
export type Recovery = { requeued: RunRef[]; parked: RunRef[]; failed: RunRef[]; replayed?: ReplayedIntent[]; found?: Found };
// The containers (by task) and worktrees (by path) an unclean start found
// that belong to no live task (ADR 0003). The leftover matcher finds them.
export type Found = { containers: string[]; worktrees: string[] };
export type RunRef = { taskId: string; runId: string };

// A multi-step operator verb with side effects outside the store, journaled
// before its first such step (ADR 0003). Its steps can each be taken again,
// so the next daemon finishes it, or rolls it back, before it reconciles
// runs. Each is keyed by what it does: the same verb is never journaled twice.
export type Intent =
  // A confirmed handoff: the daemon commits the files of `committed`, then
  // the task is handed off as the operator confirmed it.
  | { id: string; verb: 'handoff'; taskId: string; handoff: Omit<HandedOff, 'type' | 'intent'> }
  // A run's `spawn_child` call, keyed by the run and its tool call: the
  // daemon cuts the child's worktree from `startPoint`, then the child is
  // spawned. A research child's `base` is read from its worktree once cut.
  | { id: string; verb: 'spawn'; taskId: string; spawn: Omit<ChildSpawned, 'intent'>; startPoint: string }
  // A takeover that ended an L2 run: the daemon restarts the task's
  // container, which ends the turn the run left there, and brings its
  // commits out to the host task branch, where the operator converses.
  | { id: string; verb: 'takeover'; taskId: string }
  // A spec task's launch of a ticket task, keyed by the spec task and the
  // ticket: the daemon cuts the ticket task's worktree from the spec task's
  // branch and merges `origin/<base>` into it, then the ticket task is
  // launched (ADR 0013).
  | { id: string; verb: 'launch'; taskId: string; launch: Omit<TicketTaskLaunched, 'intent'> };
// The verbs a recovery report says it replayed: the journaled ones, and a
// cleanup, which the task itself holds while it is under way (ADR 0011).
export type IntentVerb = Intent['verb'] | 'cleanup';
// What recovery did with an intent: finished it, rolled it back, or
// resumed it, to finish once its steps on GitHub or Docker are through.
export type ReplayedIntent = { taskId: string; verb: IntentVerb; outcome: 'finished' | 'rolled back' | 'resumed' };
// A task's handoff sheet as the factory last held it, saved when a stop
// found it unconfirmed: reopening the sheet starts from it.
export type HandoffDraft = Pick<HandoffSheet, 'brief' | 'continueAs' | 'autonomy' | 'mergePolicy' | 'tier' | 'maxTurns'>;

// A GitHub repository the operator registered through their own clone
// (ADR 0010). Its settings live only here, never in the repo.
export type Repository = {
  // `owner/name` on GitHub.
  id: string;
  path: string;
  baseBranch: string;
  defaultPreset: string;
  // True while the clone is no longer at `path`: its runs can't start.
  missing: boolean;
  registeredAt: number;
  // Whether the factory identity's App is installed on it, as last checked.
  // Repositories stored before the check have none until the daemon starts.
  app?: AppCheck;
  // Whether the skill set's per-repo setup is on its base branch, as last
  // checked. Repositories stored before the check have none until the daemon starts.
  skills?: SkillsSetup;
};

// Whether the factory identity's App is installed on a repository (ADR 0004),
// and when the daemon last asked GitHub. Where it is, `permissions` are those
// its installation grants, and `settingsUrl` is where the operator approves
// more. Where it isn't, `reason` says why and `fixUrl` opens the installation
// settings, unless the fix is elsewhere.
export type AppCheck =
  | { installed: true; checkedAt: number; permissions: Permissions; settingsUrl: string }
  | { installed: false; checkedAt: number; reason: string; fixUrl: string | null };

// The permissions L3 needs the App's installation to grant beyond L2's
// (ADR 0014): reading a PR's check runs and commit statuses before a merge.
// Each by the name GitHub's settings give it.
const L3_NEEDS: Partial<Record<AppPermission, string>> = { checks: 'Checks read', statuses: 'Statuses read' };

// Why an L3 task can't run on `repo` as its App was checked, with the link
// that fixes it, or null when it can or the App is unchecked yet. A check
// stored before the App asked for L3's permissions recorded none, so it
// counts as unchecked: the daemon checks again before it decides. There is
// no fallback to L2 (ADR 0004): the operator approves the permissions, or
// picks a lower level themselves.
export function l3Refusal(repo: string, check: AppCheck | null | undefined): { reason: string; fixUrl: string | null } | null {
  if (!check) return null;
  if (!check.installed) return { reason: `L3 works as the factory’s App on ${repo}. ${check.reason}`, fixUrl: check.fixUrl };
  if (!check.permissions) return null;
  const missing = (Object.keys(L3_NEEDS) as AppPermission[]).filter((name) => !check.permissions[name]);
  if (!missing.length) return null;
  const named = missing.map((name) => L3_NEEDS[name]).join(' and ');
  return {
    reason: `L3 merges a PR only once its checks pass, so the factory’s GitHub App needs ${named} on ${repo}, which its installation doesn’t grant yet. Approve the App’s new permissions on GitHub, or pick L2.`,
    fixUrl: check.settingsUrl ?? null,
  };
}

// `l3Refusal` as a refusal's text: its reason, and the link to follow.
export function l3RefusalText(repo: string, check: AppCheck | null | undefined): string | null {
  const refusal = l3Refusal(repo, check);
  if (!refusal) return null;
  const fix = check?.installed ? 'Approve them at' : 'Install it from';
  return `${refusal.reason}${refusal.fixUrl ? ` ${fix} ${refusal.fixUrl}, then try again.` : ''}`;
}

// Why a task on `repo` can't be at `level`, as the guard says: only L3 is
// refused, where the repository's App check refuses it.
function levelRefused(state: Lifecycle, repo: string, level: AutonomyLevel): string | null {
  return level === 'L3' ? l3RefusalText(repo, state.repositories[repo]?.app) : null;
}

// Whether the skill set's per-repo setup (ADR 0010) is on a repository's
// base branch on origin, and when the daemon last looked. Where it isn't,
// `reason` says what is missing, and the `setup` preset sets it up; or, when
// `failed`, why the daemon couldn't look.
export type SkillsSetup = { present: true; checkedAt: number } | { present: false; checkedAt: number; reason: string; failed: boolean };

// A file or GitHub issue a run produced, linked to its task. A file is the
// glossary or an ADR in the task's worktree, by its path there (with `/`);
// `committed` says whether the worktree has committed its latest change.
export type Artifact = { id: string; taskId: string; runId: string } & (
  | { kind: 'file'; path: string; committed: boolean }
  | { kind: 'issue'; url: string }
);

export type Lifecycle = {
  counters: { task: number; run: number; request: number; artifact: number; queue: number };
  repositories: Record<string, Repository>;
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  requests: Record<string, AttentionRequest>;
  artifacts: Record<string, Artifact>;
  samples: Record<string, UsageSample>;
  // The latest usage snapshot of each usage window, by its kind (ADR 0008).
  // Stores saved before snapshots have none.
  snapshots: UsageSnapshots;
  // The verbs under way outside the store (ADR 0003), by id.
  intents: Record<string, Intent>;
  slotCap: number;
  // Whether the machine is kept from idle sleep while an AFK run is active
  // (ADR 0003). On unless the operator turned it off; factories stored
  // before it have none, and keep it on.
  keepAwake?: boolean;
};

// The operator's verbs.
export type OperatorCommand =
  | {
      type: 'createTask';
      title: string;
      repo: string;
      mode: Mode;
      autonomy?: AutonomyLevel;
      priority?: Priority;
      groups?: string[];
      submit?: boolean;
    }
  | { type: 'submit'; taskId: string }
  // Opens a HITL task's conversation. At a work loop between its tickets it
  // starts the ticket `ticket` of the map's frontier, by default the first.
  | { type: 'open'; taskId: string; ticket?: string }
  | { type: 'sendMessage'; taskId: string; text: string }
  // Cuts the agent's turn short; the run lives on.
  | { type: 'interrupt'; taskId: string }
  | { type: 'answerQuestion'; taskId: string; questionId: string; answers: Answers }
  // Backs out of the handoff sheet: the conversation carries on.
  | { type: 'closeHandoff'; taskId: string }
  // Expands a quick launch into a full conversation (`ctrl+e`): its grill
  // goes on as long as the operator likes, and opens no handoff sheet itself.
  | { type: 'expandQuickLaunch'; taskId: string }
  | { type: 'takeOver'; taskId: string }
  // Answers the task's open attention request: a question's with `answers`,
  // a permission request's with `permission`. A failed L2
  // run's is retried with `allowHosts`, hosts it was denied, allowed for the
  // task from now on (ADR 0007). A spec task that can launch no more
  // tickets but its skipped ones (ADR 0013) takes `relaunch`, one of them to
  // launch a new ticket task on, or `end`: Done, leaving its spec open or
  // closing it anyway.
  | { type: 'answer'; taskId: string; answers?: Answers; permission?: PermissionAnswer; allowHosts?: string[]; relaunch?: string; end?: SpecEnd }
  // Resumes the root's session on the operator's review comments.
  | { type: 'requestChanges'; taskId: string; comments: string }
  // Publishes an L1 root in review as the factory's App, without raising its
  // level (ADR 0007): the daemon pushes its task branch, then opens its
  // draft PR, unless it has one already, which the push updates.
  | { type: 'pushAndOpenPr'; taskId: string }
  // Reopens the root's PR, closed without merging, as the factory's App: the
  // daemon reopens it on GitHub first. The root stays In review.
  | { type: 'reopenPr'; taskId: string }
  // Finishes a root In review. Unless `anyway`, the daemon first checks that
  // its task branch is merged into the base branch on origin.
  | { type: 'markDone'; taskId: string; anyway?: boolean }
  // Cancels the task and its whole subtree. `branch` says what happens to
  // the task branch. Without it, the daemon asks the operator when the
  // branch holds commits on no branch of origin, and otherwise discards it;
  // the Lifecycle itself keeps it. A descendant's branch is deleted with the tree.
  | { type: 'cancel'; taskId: string; branch?: BranchChoice }
  // Sets the tier the task's next runs start at; a live run keeps its model.
  | { type: 'retier'; taskId: string; tier: Tier }
  // Sets an AFK task's autonomy level between runs, clamped by its stage's ceiling.
  | { type: 'setAutonomy'; taskId: string; autonomy: AutonomyLevel }
  | { type: 'setSlotCap'; cap: number }
  | { type: 'setKeepAwake'; on: boolean }
  // Unregisters the repository. Without `anyway`, the daemon asks the
  // operator first while it has leftovers no live task has (ADR 0011).
  | { type: 'removeRepo'; repo: string; anyway?: boolean }
  // Dismisses the Factory recovered report: it asks nothing but to be read.
  | { type: 'dismiss'; requestId: string };

// What the executor reports about a run.
export type RunEvent =
  // The daemon names a session, for a next AFK stage whose context is fresh.
  // A child task's run carries the commits on its branch since it was cut,
  // and the agent's final result text, its report's summary if it reported none.
  // An L2 run's end carries the hosts its container's egress proxy denied it.
  | { type: 'runCompleted'; runId: string; sessionId?: string; commits?: string[]; result?: string; deniedHosts?: string[] }
  | { type: 'runStarted'; runId: string; pid: number; createdAt: number; model: string }
  // `afterWake` when the daemon saw it fail shortly after the machine woke
  // (ADR 0003), so its failure request can say so.
  | { type: 'runFailed'; runId: string; reason: string; deniedHosts?: string[]; afterWake?: boolean }
  // The agent finished answering: the conversation is the operator's again.
  // `context` is how full the session is now, when the executor knows.
  | { type: 'turnEnded'; runId: string; context?: ContextUse }
  | { type: 'questionAsked'; runId: string; question: Question }
  // An AFK run asked the operator through `AskUserQuestion`.
  | { type: 'attentionRaised'; runId: string; kind: 'question'; question: Question }
  // An AFK run's tool call that neither the factory's allow list nor the
  // operator's rules cover (the daemon checks those): `parts` is the parts
  // of it they leave uncovered, the whole call if absent. `rulesProblem`
  // says why the operator's permissions file granted nothing, if it couldn't be read.
  | { type: 'permissionAsked'; runId: string; call: ToolCall; parts?: ToolCall[]; rulesProblem: string | null }
  // The agent called `propose_advance`.
  | { type: 'advanceProposed'; runId: string; reason: string }
  // The agent called `propose_handoff`.
  | { type: 'handoffProposed'; runId: string; reason: string }
  // The HITL run wrote the handoff brief the factory asked it for.
  | { type: 'briefWritten'; runId: string; brief: Brief }
  // A review stage's AFK run reported its findings through
  // `report_findings`; its fix pass reports those it left unfixed.
  | { type: 'findingsReported'; runId: string; findings: string[] }
  // A PR body stage's AFK run wrote the body through `write_pr_body`.
  | { type: 'prBodyWritten'; runId: string; body: string; title?: string }
  // An AFK run set its task's one-line status through `report_progress`.
  | { type: 'progressReported'; runId: string; status: string }
  // A child task's run reported its result through `report_result`.
  | { type: 'resultReported'; runId: string; summary: string; status: string; notes: string }
  // The agent cancelled one of its own children through `cancel_child`,
  // with that child's subtree.
  | { type: 'childCancelled'; runId: string; childId: string }
  // One API message's usage, as the run streamed it: a message streams once
  // per content block, so the same `messageId` may come more than once.
  | { type: 'usageSampled'; runId: string; messageId: string; model: string; usage: Usage }
  // The run's session's usage so far, per model, as a result reports it: a
  // resumed session's counts the runs before.
  | { type: 'usageTotaled'; runId: string; models: ModelUsage }
  // The run saw a usage window's reading (a `rate_limit_event`, or the
  // CLI's `/usage`): its status, the share of it spent (0 to 1) and when it
  // resets, in ms, where it says.
  | { type: 'usageSnapshotSeen'; runId: string; window: UsageWindowKind; status: UsageWindowStatus | null; spent: number | null; resetsAt: number | null }
  // An AFK run's request hit a usage limit, and Claude Code's retry
  // watchdog waits `waitMs` for it to reset before retrying.
  | { type: 'windowWaited'; runId: string; waitMs: number };

// The agent spawned a child task through `spawn_child` (ADR 0009), and the
// daemon cut its branch from the parent's tip, `base`, into its worktree.
// `toolUseId` is the call's, by which a replay finds the child. `tier` and
// `autonomy` are what the agent asked for, if anything: the child never
// gets more than the spawning run has.
export type ChildSpawned = {
  type: 'childSpawned';
  runId: string;
  toolUseId: string;
  title: string;
  goal: string;
  skill: string | null;
  tier: Tier | null;
  autonomy: AutonomyLevel | null;
  // Whether the parent waits for it, if the agent said: the Lifecycle
  // decides the default by the spawning run's mode (`awaitsChild`).
  awaited: boolean | null;
  // The research ticket (`owner/name#n`) and branch name after `research/`
  // of a research child (ADR 0007), whose branch is cut from the base branch.
  research: { ticket: string; name: string } | null;
  // The `child` preset, frozen for it.
  preset: FrozenPreset;
  worktree: TaskWorktree;
  base: string;
  sessionId: string;
  // The spawn's intent, which it finishes.
  intent?: string;
};

// What artifact capture found after a tool call of the task's latest run,
// with whether each of the task's files (old and new) is committed. Hooks
// run in the background, so it may land after that run ended.
export type ArtifactsSeen = {
  type: 'artifactsSeen';
  taskId: string;
  files: { path: string; committed: boolean }[];
  issues: string[];
};

// What the daemon learns about the operator's clones.
export type RepoEvent =
  | { type: 'repoRegistered'; repo: string; path: string; baseBranch: string; defaultPreset: string }
  | { type: 'repoMissing'; repo: string; reason: string }
  | { type: 'repoFound'; repo: string }
  | { type: 'appChecked'; repo: string; check: AppCheck }
  | { type: 'skillsChecked'; repo: string; check: SkillsSetup }
  // `repo move`: the clone is at `path` now, and its task worktrees repaired.
  | { type: 'repoMoved'; repo: string; path: string };

// A task the daemon launched once its preset was frozen and its worktree cut.
// The daemon names the session, so the Claude session file can be found by it.
export type TaskLaunched = {
  type: 'taskLaunched';
  repo: string;
  title: string;
  // What the launch asks for, summarised by the cheap run that named the task, if it did.
  launchSummary?: string | null;
  // The launch inputs: those its start stage needs, at least.
  prompt: string;
  issues: string[];
  groups: string[];
  // The tier the operator picked on the launch card, if any.
  operatorTier: Tier | null;
  preset: FrozenPreset;
  // The start stage, and its first run's first message.
  stage: string;
  opening: string;
  // The handoff fields, which an AFK start stage's runs take.
  autonomy: AutonomyLevel;
  // Launches made before merge policies have none: `operator`.
  mergePolicy?: MergePolicy;
  maxTurns: number | null;
  priority: Priority;
  // Whether it is a quick launch (`n`), whose HITL start stage is a short grill.
  quick: boolean;
  worktree: TaskWorktree;
  sessionId: string;
  skillSet: string;
  // The one issue ref with no sub-issues it launched on, at a stage that
  // works tickets: it is a ticket task for that issue (ADR 0013).
  ticket?: string | null;
  // The spec and tickets it launched on, at a stage that launches ticket
  // tasks: it is a spec task over them (ADR 0013).
  specSet?: Pick<TicketSet, 'spec' | 'tickets'> | null;
};

// The daemon cut the worktree of the spec task's ticket task on `ticket`,
// `ticketTaskId`, from the spec task's branch merged with the latest
// `origin/<base>` (ADR 0013): the ticket task is launched, titled after
// its ticket, and queues for a slot.
export type TicketTaskLaunched = {
  type: 'ticketTaskLaunched';
  taskId: string;
  ticket: string;
  ticketTaskId: string;
  title: string;
  worktree: TaskWorktree;
  sessionId: string;
  intent?: string;
};

// What the daemon did for a spec task on GitHub and in git (ADR 0013): it
// read its tickets, or couldn't, or couldn't launch the ticket task of
// `ticket`, saying why.
// A read carries the count of reads owed when it started, and, for a set
// with a spec, its sub-issues in their order then and whether it was open.
export type TicketSetEvent =
  | { type: 'ticketSetRead'; taskId: string; issues: Issue[]; reads?: number; tickets?: string[]; specOpen?: boolean }
  | { type: 'ticketSetUnread'; taskId: string; reason: string }
  | { type: 'ticketTaskUnlaunched'; taskId: string; ticket: string; reason: string };

// The operator confirmed the advance sheet: the task leaves its stage for the
// next one it didn't skip (only optional stages can be). The daemon names a
// session, for a next stage whose context is fresh. At a work loop it
// finishes the live ticket instead, and once the map cleared may jump over
// the next stage, or `end` the task (In review).
export type StageAdvanced = { type: 'stageAdvanced'; taskId: string; skip: string[]; sessionId: string; end?: boolean };

// The operator opened the handoff sheet (`ctrl+h` or `/handoff`), and the
// daemon read how the task's worktree stands.
// `quick` when the factory opened it to end a quick launch's grill.
// For a handoff to a stage launching ticket tasks, it read the spec candidates too.
export type HandoffOpened = { type: 'handoffOpened'; taskId: string; readiness: Readiness; quick?: boolean; ticketSets?: HandoffTicketSets | null };

// The daemon read the worktree again for the open handoff sheet, such as
// once the agent's turn ended: it may have changed files meanwhile.
export type ReadinessRead = { type: 'readinessRead'; taskId: string; readiness: Readiness };

// The brief and fields the operator confirms the handoff sheet with, and
// the spec candidates they kept selected: the one confirmed makes the task
// a spec task over its tickets (ADR 0013), and with none it is one AFK run
// on the brief.
export type HandoffChoices = { brief: Brief; continueAs: ContinueAs; autonomy: AutonomyLevel; mergePolicy?: MergePolicy; tier: Tier; maxTurns: number; specs?: string[] };

// The operator confirmed the handoff sheet, and the daemon committed the
// task's uncommitted files of `committed`. The daemon names a session, for
// continuing fresh.
// `intent` is the intent it finishes, when the daemon journaled one.
export type HandedOff = { type: 'handedOff'; taskId: string; committed: string[]; sessionId: string; intent?: string } & HandoffChoices;

// The daemon journaled an intent before its first step outside the store,
// or dropped it: finished outside the store, or rolled back (ADR 0003).
export type IntentEvent = { type: 'intentJournaled'; taskId: string; intent: Intent } | { type: 'intentDropped'; taskId: string; intentId: string };

// The daemon deleted a child's kept branch (ADR 0011): its parent's branch
// had merged it, or its root ended.
export type ChildBranchDeleted = { type: 'childBranchDeleted'; taskId: string };

// What the daemon did to clean up after a task ended Done or Cancelled
// (ADR 0011): archived its transcripts to `transcripts`, then removed its
// worktree and (unless kept) its local task branch, or failed to, saying why.
// A root's cleanup deletes its tree's kept child branches too: those of
// `childBranches`, by their tasks.
export type CleanupEvent =
  | { type: 'cleanedUp'; taskId: string; transcripts: string; childBranches?: string[] }
  | { type: 'cleanupFailed'; taskId: string; reason: string };

// The daemon's clock found deadlines that have passed (ADR 0003).
export type ClockEvent = { type: 'deadlinesDue' };

// The daemon ends every live run, since no new daemon can reattach to one
// (ADR 0002, ADR 0003): on a graceful stop, or at a start that found no
// clean-shutdown marker (`unclean`). Active AFK runs end `interrupted` and
// their tasks queue again; suspended and HITL runs park. `replayed` is what
// the daemon replayed of the intents it found unfinished, just before, and
// `found` the leftovers an unclean start found.
export type Reconciled = { type: 'runsReconciled'; interruption: Interruption; replayed?: ReplayedIntent[]; found?: Found };

// What the daemon read on GitHub between a work loop's tickets (ADR 0012):
// its map's tickets, in sub-issue order, naming a session for the ticket
// the operator picks next, or why it couldn't read them.
export type LoopEvent =
  | { type: 'mapRead'; taskId: string; tickets: Issue[]; sessionId: string }
  | { type: 'ticketsUnread'; taskId: string; reason: string };

// What the daemon did for a root's Push & open draft PR: it committed a
// setup task's setup files, with `publish` false when its branch then has
// nothing for the base branch, pushed the task branch's tip `commit`, found
// it changes workflow files it may not push, opened the draft PR, or failed
// a step, saying why.
export type PublishEvent =
  | { type: 'setupCommitted'; taskId: string; publish: boolean }
  | { type: 'branchPushed'; taskId: string; commit: string }
  | { type: 'pushRefused'; taskId: string; workflowFiles: string[] }
  | { type: 'prOpened'; taskId: string; pr: PullRequest }
  | { type: 'publishFailed'; taskId: string; step: Publishing['step']; reason: string };

// What the daemon did on GitHub for a research child that reported (ADR
// 0007): it pushed its research branch, found it touches paths outside
// `docs/research/` it may not push, closed its research ticket, or failed a
// step, saying why.
export type ResearchEvent =
  | { type: 'researchPushed'; taskId: string }
  | { type: 'researchPushRefused'; taskId: string; paths: string[] }
  | { type: 'researchClosed'; taskId: string }
  | { type: 'researchFailed'; taskId: string; step: NonNullable<Research['step']>; reason: string };

// What the daemon did about a merged ticket task's ticket (ADR 0013): it
// found it closed, or closed it as its App, or couldn't, saying why.
export type ResolutionEvent = { type: 'ticketResolved'; taskId: string } | { type: 'ticketUnresolved'; taskId: string; reason: string };

// What the daemon did about a spec task's spec once none of its tickets was
// open (ADR 0013): it found it closed, or closed it as its App, or couldn't,
// saying why.
export type SpecClosingEvent = { type: 'specClosed'; taskId: string } | { type: 'specUnclosed'; taskId: string; reason: string };

// What the daemon did about a wayfinder task's maps it owed their closing
// (ADR 0013): it found them closed, or closed them as its App, or couldn't,
// saying why.
export type MapClosingEvent = { type: 'mapClosed'; taskId: string } | { type: 'mapUnclosed'; taskId: string; reason: string };

// The daemon delivered the factory notes the HITL task held to its live
// run, on the operator's turn.
export type NoteEvent = { type: 'notesDelivered'; taskId: string };

// What the daemon read of an In review root's PR on GitHub (ADR 0011):
// where it stands, and whether GitHub finds it mergeable (ADR 0013); its
// head commit, and for a root at an agent policy's merge gate the checks
// on it (ADR 0014).
export type PrReadEvent = { type: 'prRead'; taskId: string; state: PrState; mergeable: Mergeability; head?: string; draft?: boolean; checks?: Checks | null };

// What the daemon did on GitHub for a root its merge gate let through (ADR
// 0014): it marked the draft PR ready, merged it, or failed a step, saying why.
export type MergeEvent =
  | { type: (typeof MERGE_STEP_DONE)[MergeStep]; taskId: string }
  | { type: 'mergeFailed'; taskId: string; step: MergeStep; reason: string };

export type LifecycleAction =
  | OperatorCommand
  | RunEvent
  | RepoEvent
  | TaskLaunched
  | ChildSpawned
  | StageAdvanced
  | HandoffOpened
  | ReadinessRead
  | HandedOff
  | IntentEvent
  | ClockEvent
  | Reconciled
  | LoopEvent
  | PublishEvent
  | PrReadEvent
  | MergeEvent
  | NoteEvent
  | ResearchEvent
  | ResolutionEvent
  | SpecClosingEvent
  | MapClosingEvent
  | TicketTaskLaunched
  | TicketSetEvent
  | CleanupEvent
  | ChildBranchDeleted
  | ArtifactsSeen;

export type Reduction = { state: Lifecycle; refusal: string | null };

export const DEFAULT_SLOT_CAP = 8;
// The global default for an AFK run's max turns, under a stage's `max_turns`.
export const DEFAULT_MAX_TURNS = 300;
// What a resumed AFK run opens on: it takes no chat, so nothing else would
// start its turn.
const AFK_RESUME = 'Carry on, unattended, from where this conversation left off.';
// What the run after an interrupted one opens on (ADR 0003): its worktree is
// left exactly as the interrupted turn left it.
export const RECOVERY_NOTE =
  'The factory restarted mid-turn. Your last turn may be incomplete. Check `git status` and re-verify before continuing.';
// How many unclean starts in a row may find a task's run active before it
// fails instead of being requeued (ADR 0003).
const CRASH_LOOP_STARTS = 2;
export const PRIORITIES: readonly Priority[] = ['normal', 'urgent'];
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['L1', 'L2', 'L3'];
// The levels as a refusal names them: `L1, L2 or L3`.
const LEVELS_TEXT = `${AUTONOMY_LEVELS.slice(0, -1).join(', ')} or ${AUTONOMY_LEVELS.at(-1)}`;

// Whether `level` is `floor` or above: `requires: L2` means L2 or L3 (ADR 0014).
export function atLeast(level: AutonomyLevel | null | undefined, floor: AutonomyLevel): boolean {
  return !!level && AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(floor);
}

// Whether a run at `level` executes in its task's own container (ADR 0007):
// at L2, and at L3, contained alike (ADR 0014).
export function runsContained(level: AutonomyLevel | null | undefined): boolean {
  return atLeast(level, 'L2');
}

// Whether the factory publishes a task's code unattended at `level` (ADR
// 0007), pushing its branch and opening its draft PR: at L2 and L3.
export function publishesCode(level: AutonomyLevel | null | undefined): boolean {
  return atLeast(level, 'L2');
}
// Past this share of the context window, the handoff sheet pre-selects
// continuing fresh from the brief.
export const FRESH_AT = 0.6;
// The most questions a quick launch's grill asks before its handoff sheet opens.
export const QUICK_QUESTIONS = 3;
// What the factory asks a HITL run for when the operator opens the handoff sheet.
export const BRIEF_REQUEST =
  'The operator is handing this task off to an unattended AFK run. Write the handoff brief now with the factory’s ' +
  '`write_handoff_brief` tool: the goal, what you decided together, when the work is done, what is out of scope, and ' +
  'links to the issues and files that matter. Then end your turn: the operator reviews the brief before anything is handed off.';
// How long a HITL run may wait on the operator's turn before it is parked.
export const IDLE_PARK_MS = 30 * 60_000;
// How long an attention request may keep its run suspended before the run is parked.
export const REQUEST_PARK_MS = 60 * 60_000;

export function initialLifecycle(): Lifecycle {
  return {
    counters: { task: 0, run: 0, request: 0, artifact: 0, queue: 0 },
    repositories: {},
    tasks: {},
    runs: {},
    requests: {},
    artifacts: {},
    samples: {},
    snapshots: {},
    intents: {},
    slotCap: DEFAULT_SLOT_CAP,
  };
}

// The id the next task created will get.
export function nextTaskId(state: Lifecycle): string {
  return `T${state.counters.task + 1}`;
}

// ---- Selectors ----

export function isTerminal(task: Task): boolean {
  return task.state === 'done' || task.state === 'cancelled';
}

// The repository's tasks that are neither Done nor Cancelled.
export function unfinishedTasks(state: Lifecycle, repo: string): Task[] {
  return Object.values(state.tasks).filter((task) => task.repo === repo && !isTerminal(task));
}

// The task and every task descended from it, the task first.
export function subtree(state: Lifecycle, task: Task): Task[] {
  const tree = [task];
  for (let i = 0; i < tree.length; i++) {
    for (const child of Object.values(state.tasks)) if (child.parent === tree[i]!.id) tree.push(child);
  }
  return tree;
}

export function liveRun(state: Lifecycle, task: Task): Run | undefined {
  return task.runIds.map((id) => state.runs[id]!).find((run) => run.status !== 'ended');
}

export function openRequest(state: Lifecycle, task: Task): AttentionRequest | undefined {
  return Object.values(state.requests).find((request) => request.taskId === task.id && request.status === 'open');
}

// The Factory recovered report while the operator hasn't dismissed it.
function recoveryReport(state: Lifecycle): AttentionRequest | undefined {
  return Object.values(state.requests).find((request) => request.kind === 'recovery-report' && request.status === 'open');
}

// The open request about the repository itself, if any.
export function openRepoRequest(state: Lifecycle, repo: string): AttentionRequest | undefined {
  return Object.values(state.requests).find((request) => request.repo === repo && request.taskId === null && request.status === 'open');
}

// Whether the root is In review with a PR, whose state on GitHub the daemon
// reads (ADR 0011).
export function waitsOnPr(task: Task): boolean {
  return task.state === 'in-review' && !!task.pr;
}

// Whether the policy is one the factory merges by: semi-auto or full-auto.
export function agentPolicy(policy: MergePolicy | null | undefined): boolean {
  return policy === 'judged' || policy === 'unattended';
}

// Whether the factory may merge the AFK root's PR (ADR 0014): its merge
// policy is an agent one and it is at L3, held to the ceiling of the stage
// it ended at, so a stage capped at L2 still forbids merging.
export function factoryMerges(task: Task): boolean {
  return !task.child && task.mode === 'AFK' && agentPolicy(task.mergePolicy) && atLeast(clampAutonomy(task.autonomy ?? 'L1', stageOf(task, task.stage)), 'L3');
}

// Whether the root waits at its merge gate for the factory to merge it
// (ADR 0014): past its last stage with its PR open and published, under an
// agent policy, rather than In review for the operator.
export function atMergeGate(task: Task): boolean {
  return waitsOnPr(task) && !task.publishing && factoryMerges(task);
}

// Why the operator can't act on the root while the factory merges its PR,
// or null.
function mergingRefusal(task: Task): string | null {
  return task.gate?.step && atMergeGate(task) ? `${task.id} is merging its PR: wait for it to finish.` : null;
}

// Why the merge policy can't be picked for a task at `level` (null for a
// task starting HITL, whose policy is picked at its handoff), or null.
export function policyRefusal(policy: MergePolicy, level: AutonomyLevel | null): string | null {
  if (!MERGE_POLICIES.includes(policy)) return `${policy} is not a merge policy (operator, judged or unattended).`;
  if (policy === 'operator') return null;
  // As the TUI names it, with its value: `Full-auto (unattended)`.
  const name = POLICY_NAMES[policy];
  const named = `${name[0]!.toUpperCase()}${name.slice(1)} (${policy})`;
  if (!OFFERED_POLICIES.includes(policy)) {
    return `${named} isn’t available yet: the factory can’t run its gate check. Pick ${OFFERED_POLICIES.map((offered) => POLICY_NAMES[offered]).join(' or ')}.`;
  }
  if (level === null) return `A task starting at a HITL stage picks its merge policy at its handoff.`;
  return level === 'L3' ? null : `${named} merges the task’s PR, which the factory does only at L3: pick L3, or the operator policy.`;
}

// The root's task branch, if the factory pushed it to GitHub: it has its
// PR, or its Push & open draft PR got past the push.
export function pushedBranch(task: Task): string | null {
  return task.worktree && (task.pr || task.publishing?.step === 'open-pr' || task.branchOnGitHub) ? task.worktree.branch : null;
}

// The registered repository the operator last launched a task in, if any.
export function lastUsedRepo(state: Lifecycle): string | null {
  return Object.values(state.tasks).findLast((task) => task.repo in state.repositories)?.repo ?? null;
}

export function artifactsOf(state: Lifecycle, task: Task): Artifact[] {
  return Object.values(state.artifacts).filter((artifact) => artifact.taskId === task.id);
}

// Every issue the task recorded, at any stage, then those it launched on,
// each once: the spec candidates of its handoff are among them (ADR 0013).
export function recordedIssues(state: Lifecycle, task: Task): string[] {
  const issues = artifactsOf(state, task).flatMap((artifact) => (artifact.kind === 'issue' ? [issueRef(artifact.url)] : []));
  return [...new Set([...issues, ...(task.inputs?.issues ?? [])])];
}

// The task's issues of an artifact kind (`spec`…), as `owner/name#n`: those
// captured in a stage whose exit is `artifact:<kind>`, so an issue the grill
// merely printed is no spec.
export function issuesOfKind(state: Lifecycle, task: Task, kind: string): string[] {
  return artifactsOf(state, task).flatMap((artifact) => {
    if (artifact.kind !== 'issue') return [];
    const stage = stageOf(task, state.runs[artifact.runId]?.stage);
    if (stage?.exit !== `artifact:${kind}`) return [];
    return [issueRef(artifact.url)];
  });
}

// The task's issues of an artifact kind, else the launch issue refs that
// stand for that kind.
function issuesFor(state: Lifecycle, task: Task, kind: string): string[] {
  const issues = issuesOfKind(state, task, kind);
  if (issues.length) return issues;
  return task.inputs?.issueKinds.includes(kind) ? task.inputs.issues : [];
}

// The task's maps in its own repository, which the factory closes as its
// App (ADR 0013): those its chart stage made, or the launch refs standing
// for them.
export function mapsOf(state: Lifecycle, task: Task): string[] {
  return issuesFor(state, task, 'map').filter((ref) => inRepo(task, ref));
}

// Whether the issue `ref` is in the task's own repository.
export function inRepo(task: Task, ref: string): boolean {
  return ref.toLowerCase().startsWith(`${task.repo.toLowerCase()}#`);
}

// The maps a work loop (ADR 0012) reads its tickets from: their
// sub-issues, a map never being a ticket itself. None when the task has no
// map, and its loop stage is one conversation.
export function workLoopMaps(state: Lifecycle, task: Task): string[] {
  return issuesFor(state, task, 'map');
}

// Every session the task's runs worked in, in order.
export function sessionsOf(state: Lifecycle, task: Task): string[] {
  const sessions = task.runIds.map((id) => state.runs[id]!.sessionId ?? task.sessionId);
  return [...new Set(sessions.filter((session) => session !== null))];
}

// The run the task last had, if any.
function lastRun(state: Lifecycle, task: Task): Run | undefined {
  return state.runs[task.runIds.at(-1)!];
}

// A HITL task at its work loop while the factory reads its map, before
// the operator is offered the frontier: it holds no slot.
export function readingMap(state: Lifecycle, task: Task): boolean {
  return awaitsMapRead(task) && task.state === 'queued' && !liveRun(state, task);
}

// Whether the task's work loop waits on the factory to read its map.
function awaitsMapRead(task: Task): boolean {
  return atWorkLoop(task) && task.loop!.step === 'pick';
}

// Whether the task is at its work loop over a map.
function atWorkLoop(task: Task): boolean {
  return task.mode === 'HITL' && isWorkLoop(stageOf(task, task.stage)) && !!task.loop;
}

// A work loop between its tickets, waiting on the operator to pick one
// from the frontier.
function picksFromFrontier(task: Task): boolean {
  return atWorkLoop(task) && !task.loop!.step && !task.loop!.ticket && !task.loop!.cleared && !!task.loop!.frontier?.length;
}

// A work loop's states between the factory's reads of its map (`picking()`
// is the read itself): offering the frontier, with the session the picked
// ticket starts; cleared; or working one ticket.
function workLoop(state: Pick<Loop, 'ticket' | 'frontier' | 'session' | 'cleared'>): Loop {
  return { step: null, ...state };
}

// The tier the task's next run starts at: the operator's, then its stage's,
// then the global default.
export function nextTier(task: Task): Tier {
  return task.operatorTier ?? task.inputs?.tier ?? task.delegatedTier ?? stageOf(task, task.stage)?.model ?? DEFAULT_TIER;
}

// `tier`, or `ceiling` when `tier` is above it: an agent may only choose its
// own run's tier or a lower one (ADR 0009).
export function clampTier(tier: Tier, ceiling: Tier): Tier {
  return TIERS[Math.max(TIERS.indexOf(tier), TIERS.indexOf(ceiling))]!;
}

// The root of the task's tree: the task itself, for a root.
export function rootOf(state: Lifecycle, task: Task): Task {
  let root = task;
  while (root.parent && state.tasks[root.parent]) root = state.tasks[root.parent]!;
  return root;
}

// The task's children, in the order they were spawned.
export function childrenOf(state: Lifecycle, task: Task): Task[] {
  return Object.values(state.tasks).filter((child) => child.parent === task.id);
}

// The tree limits a task's tree spawns under: the global ones, as its root's
// preset lowers them.
export function treeLimits(state: Lifecycle, task: Task): TreeLimits {
  const lowered = rootOf(state, task).preset?.limits ?? {};
  const limits = { ...TREE_LIMITS };
  for (const limit of Object.keys(limits) as (keyof TreeLimits)[]) limits[limit] = Math.min(limits[limit], lowered[limit] ?? limits[limit]);
  return limits;
}

// Whether the task's runs may spawn children at all: its tree goes deeper.
export function spawnsWithinDepth(state: Lifecycle, task: Task): boolean {
  return depthOf(task) < treeLimits(state, task).depth;
}

// How many children a task may still spawn: the fewer of its own
// children left and its tree's descendants left (ADR 0009). Zero past the depth.
export function fanOutLeft(state: Lifecycle, task: Task): number {
  if (!spawnsWithinDepth(state, task)) return 0;
  const limits = treeLimits(state, task);
  const descendants = subtree(state, rootOf(state, task)).length - 1;
  return Math.max(0, Math.min(limits.children - childrenOf(state, task).length, limits.descendants - descendants));
}

// How deep the task is in its tree: a root is 0.
export function depthOf(task: Task): number {
  return task.child?.depth ?? 0;
}

// The child the run's tool call `toolUseId` spawned, if it did.
export function childSpawnedBy(state: Lifecycle, runId: string, toolUseId: string): Task | undefined {
  return Object.values(state.tasks).find((task) => task.child?.spawnedBy.runId === runId && task.child.spawnedBy.toolUseId === toolUseId);
}

// Why the run's task can't spawn another child, or null: the tree limits
// (ADR 0009). The agent reads it, and no attention request is raised.
export function spawnLimit(state: Lifecycle, task: Task): string | null {
  const limits = treeLimits(state, task);
  if (!spawnsWithinDepth(state, task)) return `${task.id} is at depth ${depthOf(task)}, and its tree goes no deeper than ${limits.depth}: do this work yourself.`;
  const spawned = childrenOf(state, task).length;
  if (spawned >= limits.children) return `${task.id} has spawned ${spawned} children, the most a task may: do this work yourself.`;
  const descendants = subtree(state, rootOf(state, task)).length - 1;
  if (descendants >= limits.descendants) return `${task.id}’s tree has ${descendants} descendants, the most a tree may: do this work yourself.`;
  return null;
}

// What a task's descendants are doing, for its tree row (ADR 0009): how
// many are done, running (or queued), need the operator, or were cancelled,
// and each one whose failure waits on the operator, which bubbles up to the
// root. Null for a task with no descendants.
export type Rollup = { done: number; running: number; needsYou: number; cancelled: number; failed: { taskId: string; reason: string | null }[] };

// The task's rollup over its descendants, or null when it has none.
export function treeRollup(state: Lifecycle, task: Task): Rollup | null {
  const descendants = subtree(state, task).slice(1);
  if (descendants.length === 0) return null;
  const rollup: Rollup = { done: 0, running: 0, needsYou: 0, cancelled: 0, failed: [] };
  for (const descendant of descendants) {
    if (descendant.state === 'done') rollup.done++;
    else if (descendant.state === 'cancelled') rollup.cancelled++;
    else if (descendant.state === 'waiting') rollup.needsYou++;
    else rollup.running++;
    const request = descendant.state === 'waiting' ? openRequest(state, descendant) : undefined;
    if (request?.kind === 'failure') rollup.failed.push({ taskId: descendant.id, reason: request.reason });
  }
  return rollup;
}

// The level an AFK stage's runs take: the asked one, held to its ceiling.
function clampAutonomy(level: AutonomyLevel, stage: Stage | undefined): AutonomyLevel {
  return stage?.autonomy && !atLeast(stage.autonomy, level) ? stage.autonomy : level;
}

function stageOf(task: Task, id: string | null | undefined): Stage | undefined {
  return task.preset?.stages.find((stage) => stage.id === id);
}

// Why the stage's exit doesn't hold yet, or null. Its run ends completed
// on either boundary (on a HITL one by the operator's confirm), so
// `run-completed` holds.
function unmetExit(state: Lifecycle, task: Task, stage: Stage): string | null {
  if (stage.exit === undefined || stage.exit === 'run-completed') return null;
  // A spec task's holds once its spec closes; any other task's one run on
  // the stage ends it, as a ticket task's on its ticket.
  if (stage.exit === 'spec-closed') return task.kind !== 'spec' || task.ticketSet?.closed ? null : `${stage.id}’s exit, spec-closed, doesn’t hold: ${task.ticketSet?.spec ?? 'its spec'} is still open.`;
  // Read from GitHub between the work loop's tickets.
  if (stage.exit === 'map-cleared') {
    return task.loop?.cleared ? null : `${stage.id}’s exit, map-cleared, doesn’t hold: ${issuesFor(state, task, 'map').join(', ') || 'the map'} still has open tickets.`;
  }
  const kind = /^artifact:(.*)$/.exec(stage.exit)?.[1];
  // The PR body is the one artifact kind that is no issue.
  const made = kind === 'pr-body' ? !!task.prBody : !!kind && issuesOfKind(state, task, kind).length > 0;
  const why = kind === undefined ? `the factory can’t tell yet whether ${stage.exit} holds` : made ? null : `${task.id} has no ${kind} yet`;
  return why && `${stage.id}’s exit, ${stage.exit}, doesn’t hold: ${why}.`;
}

// A template variable of a stage's args, filled from what the task has: its
// launch prompt, or its issues of an artifact kind, else the launch issue
// refs that stand for that kind. Null when it has none.
function argValue(state: Lifecycle, task: Task, variable: string): string | null {
  if (variable === 'prompt') return task.inputs?.prompt.trim() || null;
  if (variable === 'artifacts.pr-body') return task.prBody ?? null;
  return issuesFor(state, task, variable.slice('artifacts.'.length)).join(' ') || null;
}

// Why a stage can't start: the args variables the task has no value for.
function cantFill(task: Task, stage: Stage, missing: string[]): string {
  const placeholders = missing.map((variable) => `{{${variable}}}`).join(' and ');
  const kinds = missing.map((variable) => variable.replace(/^artifacts\./, '')).join(' or ');
  return `${stage.id} can’t start: its args need ${placeholders}, and ${task.id} has no ${kinds}.`;
}

// Moves the task to the stage: the next run of a fresh-context one starts
// the session the daemon named, `sessionId`, instead of resuming. `fresh`
// starts it fresh whatever its own context.
function enterStage(task: Task, stage: Stage, sessionId: string | undefined, fresh = false): void {
  task.stage = stage.id;
  if ((stage.context !== 'fresh' && !fresh) || !sessionId) return;
  task.sessionId = sessionId;
  task.newSession = true;
}

// Starts the task's work loop at a HITL loop stage over a map: it starts
// no run, the factory reads its map, then offers the operator its frontier
// in Ready for you. A loop stage with no map is one conversation, as before.
function enterLoop(state: Lifecycle, task: Task, stage: Stage): boolean {
  if (task.mode !== 'HITL' || !isWorkLoop(stage) || workLoopMaps(state, task).length === 0) return false;
  task.loop = picking();
  task.state = 'queued';
  return true;
}

// A work loop about to read its map.
function picking(): Loop {
  return { step: 'pick', ticket: null };
}

// What a task frozen on the retired Ralph loop's stage (ADR 0013) is told.
function retiredLoopReason(task: Task, stage: Stage): string {
  return (
    `This preset’s loop was retired: ${stage.id} works tickets through the Ralph loop (exit tickets-closed), which the factory no longer runs. ` +
    `Cancel ${task.id}, or relaunch it.`
  );
}

// Whether the task is at a stage of the retired Ralph loop.
function atRetiredLoop(task: Task): boolean {
  return isRetiredLoop(stageOf(task, task.stage));
}

// The task reached, or a daemon start found it at, the retired Ralph
// loop's stage: nothing runs there, and the operator is asked to cancel or
// relaunch it. One already asked is left as it is.
function blockRetiredLoop(state: Lifecycle, task: Task, at: number): void {
  task.loop = null;
  task.resumeWith = null;
  const reason = retiredLoopReason(task, stageOf(task, task.stage)!);
  const open = openRequest(state, task);
  if (open?.kind === 'stage-blocked' && open.reason === reason) return;
  if (open) open.status = 'superseded';
  raise(state, task, lastRun(state, task), 'stage-blocked', false, reason, at);
}

// Moves the task on from the AFK stage whose exit holds: to the next AFK
// stage, queued for a slot, or In review past the last. What stops it
// raises a stage-blocked request about `run`.
function advanceFrom(state: Lifecycle, task: Task, from: Stage, run: Run | undefined, sessionId: string | undefined, at: number): void {
  const blocked = (reason: string) => raise(state, task, run, 'stage-blocked', false, reason, at);
  task.loop = null;
  // Past the last stage, the root task is the operator's to review. One
  // whose open-pr stage just opened or updated its PR has nothing to publish.
  const to = nextAfkStage(task, from);
  if (!to) {
    if (from.kind === 'action' && task.pr) {
      task.state = 'in-review';
      task.gate = null;
    } else reachReview(task);
    return;
  }
  if (to.mode === 'HITL') return blocked(`The next stage, ${to.id}, is HITL: take ${task.id} over to start it.`);
  if (to.kind === 'action') {
    if (to.id !== 'open-pr') return blocked(`The next stage, ${to.id}, is a factory action, which the factory can’t run yet.`);
    // Only L2 and above publish code unattended (ADR 0007): below it, the
    // operator's Push & open draft PR does.
    if (!publishesCode(task.autonomy)) return blocked(`The next stage, open-pr, publishes ${task.id}’s code, which the factory does unattended only at L2 or above. Give the stage \`requires: L2\` in its preset, so that L1 skips it.`);
    // The factory's own step, holding no slot: it pushes the task branch,
    // then opens the draft PR, and the stage moves on once the PR is open.
    enterStage(task, to, sessionId);
    task.publishing = { step: 'push', problem: null };
    task.state = 'running';
    return;
  }
  if (isRetiredLoop(to)) {
    enterStage(task, to, sessionId);
    return blockRetiredLoop(state, task, at);
  }
  const filled = fillOpening(to, (variable) => argValue(state, task, variable));
  if ('missing' in filled) return blocked(cantFill(task, to, filled.missing));
  // Queued as work continuing something in flight, for the scheduler.
  enterStage(task, to, sessionId);
  task.resumeWith = stageOpening(task, to, filled.opening);
  task.state = 'queued';
}

// What a stage's runs report to the factory through its tools: a
// `fix-once` review its findings, and a PR body stage the body. A run is
// given only the tools its stage reports through (ADR 0009).
export type Report = 'findings' | 'pr-body';

export function stageReports(stage: Stage | undefined): Report[] {
  return [...(stage?.on_findings === 'fix-once' ? ['findings' as const] : []), ...(stage?.exit === 'artifact:pr-body' ? ['pr-body' as const] : [])];
}

// What the AFK run reports through the factory's tools, by its stage.
export function runReports(task: Task, run: Run): Report[] {
  return run.mode === 'AFK' ? stageReports(stageOf(task, run.stage)) : [];
}

// A stage's opening with the factory context its runs need to report
// through the factory's tools. A review in its fix pass, as after a
// takeover, is told the findings to fix instead.
function stageOpening(task: Task, stage: Stage, opening: string): string {
  const reports = stageReports(stage);
  const context = reports.includes('findings')
    ? task.findings?.fixPass
      ? fixContext(task)
      : 'Report every finding of this review to the factory through its report_findings tool before you end, one finding per item; ' +
        'with none, don’t call it. Don’t fix them yourself: the factory runs one fix pass on what you report.'
    : reports.includes('pr-body')
      ? 'Write the PR body through the factory’s write_pr_body tool before you end: the factory opens the PR with it. ' +
        'Leave out the review findings left over: the factory adds those itself.'
      : null;
  return context ? `${opening}\n\n## Factory context\n${context}` : opening;
}

// What a `fix-once` review's one fix pass is told: the findings its review
// reported. If it reports nothing back, every one is left over.
function fixContext(task: Task): string {
  return (
    `The review found:\n\n${bulleted(task.findings!.found)}\n\n` +
    `Fix them now, unattended, and commit the fixes to the task branch ${task.worktree?.branch}. This is the review’s only fix pass: ` +
    'before you end, report the findings you leave unfixed through the factory’s report_findings tool, with none if you fixed them all. ' +
    'The factory puts those in the PR body.'
  );
}

function bulleted(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

// GitHub's closing keywords, before an issue ref.
const CLOSING = String.raw`(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+`;

// The issue `ref` as a PR body of `repo` cites it: `#n` in its own repository.
function citedIssue(repo: string, ref: string): string {
  const [owner, number] = ref.split('#');
  return owner!.toLowerCase() === repo.toLowerCase() ? `#${number}` : ref;
}

// Whether `text` has a closing keyword on the issue `ref`, in any form GitHub reads.
function closesIssue(text: string, repo: string, ref: string): boolean {
  return new RegExp(CLOSING + issuePattern(repo, ref), 'i').test(text);
}

// A pattern matching the issue `ref` in any form a PR body of `repo` may
// cite it in, captured: `#n` in its own repository, `owner/name#n`, or its URL.
function issuePattern(repo: string, ref: string): string {
  const [owner, number] = ref.split('#');
  const forms = [citedIssue(repo, ref), ref, `https://github.com/${owner}/issues/${number}`].map((form) => form.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return `(${forms.join('|')})(?!\\d)`;
}

// The PR body from the agent's `body`: a ticket task's closing keyword on
// its ticket, unless it has one, and the review findings the fix pass left over.
function prBody(task: Task, body: string): string {
  const text = body.trim();
  // A ticket task's PR closes its ticket on merging (ADR 0013), whatever the agent wrote.
  const closes = task.kind === 'ticket' && task.ticket && !closesIssue(text, task.repo, task.ticket) ? [`Closes ${citedIssue(task.repo, task.ticket)}`] : [];
  const leftOver = task.findings?.leftOver ?? [];
  return [
    text,
    ...closes,
    ...(leftOver.length ? [`## Review findings left over\n\n${bulleted(leftOver)}`] : []),
  ].join('\n\n');
}

// GitHub caps a PR title at 256 characters.
const PR_TITLE_LENGTH = 256;

// The PR title an agent wrote, on one line and within GitHub's cap, or null
// without one.
function prTitleOf(title: string | undefined): string | null {
  return cutToFit(oneLineOf(title ?? ''), PR_TITLE_LENGTH) || null;
}

// The draft PR the root opens (ADR 0004): its PR title (or its task's
// title), and its PR body (or, without one, its brief, launch summary or
// title) above the
// factory's footer, which names the task, each stage's models in preset
// order, and the tokens its whole tree took.
export function pullRequestOf(state: Lifecycle, task: Task): { title: string; body: string } {
  const runs = task.runIds.map((id) => state.runs[id]!);
  const models = new Map<string, string[]>();
  for (const stage of task.preset?.stages ?? []) {
    const used = [...new Set(runs.filter((run) => run.stage === stage.id).map((run) => run.model))];
    if (used.length) models.set(stage.id, used);
  }
  const tree = subtree(state, task).flatMap((member) => member.runIds.map((id) => state.runs[id]!));
  const tokens = tree.reduce((sum, run) => sum + tokensOf(overall(run.usage ?? {})), 0);
  const footer = [
    '---',
    `Opened by the agents factory for task ${task.id}.`,
    '',
    '| Stage | Model |',
    '| --- | --- |',
    ...[...models].map(([stage, used]) => `| ${stage} | ${used.join(', ')} |`),
    '',
    `Total tokens: ${tokens.toLocaleString('en-US')}`,
  ];
  if (isSetupTask(task) && !task.prBody) return { title: SETUP_PR_TITLE, body: `${setupPrBody(task)}\n\n${footer.join('\n')}` };
  const body = task.prBody ?? prBody(task, task.brief?.trim() || task.launchSummary?.trim() || task.title);
  return { title: task.prTitle || task.title, body: `${body}\n\n${footer.join('\n')}` };
}

const SETUP_PR_TITLE = 'Set up the skill set';

// What a setup task's PR says it does, and what merging it does (ADR 0010).
function setupPrBody(task: Task): string {
  return (
    `Sets ${task.repo} up for the factory’s skill set: \`docs/agents/\` and the \`## Agent skills\` block tell its skills ` +
    'where the issue tracker is, which triage labels to use and where the domain docs live. ' +
    'Once it is merged, the factory finds the setup on the base branch and stops warning that it is missing.'
  );
}

// What a ticket task's first run opens on (ADR 0013): its stage's skill on
// its ticket, and the launch prompt, if any, as the operator's instructions.
function ticketOpening(stage: Stage, ticket: string, prompt: string): string {
  const opening = stage.skill ? `/factory:${stage.skill} ${ticket}` : ticket;
  return prompt.trim() ? `${opening}\n\n## Operator instructions\n${prompt.trim()}` : opening;
}

// A ticket task became Done, or its ticket closed (ADR 0013): its spec task
// owes a read of its ticket set, which may free the tickets it blocked.
// `task` is the ticket task.
function oweTicketSetRead(state: Lifecycle, task: Task): void {
  const spec = task.specTask ? state.tasks[task.specTask] : undefined;
  const set = spec?.ticketSet;
  if (!spec || !set || isTerminal(spec) || set.closing) return;
  oweRead(set);
}

// The spec task owes a read of its ticket set from GitHub.
function oweRead(set: TicketSet): void {
  set.reading = true;
  set.reads = (set.reads ?? 0) + 1;
}

// The spec task's ticket tasks not yet finished, merged or cancelled: those its cancel cascades to.
export function unfinishedTicketTasks(state: Lifecycle, spec: Task): Task[] {
  return Object.values(spec.ticketSet?.launched ?? {}).flatMap((id) => {
    const ticketTask = state.tasks[id];
    return ticketTask && !isTerminal(ticketTask) ? [ticketTask] : [];
  });
}

// The ticket task was cancelled (ADR 0013): its spec task marks its ticket
// skipped, never launching it again, and owes a read of its ticket set, so
// that it asks the operator once nothing more can be launched.
function skipTicket(state: Lifecycle, task: Task): void {
  const set = task.specTask ? state.tasks[task.specTask]?.ticketSet : undefined;
  if (!set || !task.ticket || set.launched[task.ticket] !== task.id) return;
  if (!(set.skipped ??= []).includes(task.ticket)) set.skipped.push(task.ticket);
  oweTicketSetRead(state, task);
}

// The spec task's spec closed, or it has none: the wayfinder maps it was
// written from close next (ADR 0013), unless one of them is the spec, as
// when the spec stage was jumped over; then the spec task is Done.
function specResolved(state: Lifecycle, task: Task, request: AttentionRequest | undefined): void {
  const spec = task.ticketSet!.spec;
  const maps = spec ? mapsOf(state, task) : [];
  if (spec && maps.length && !maps.includes(spec)) {
    task.mapClosing = { maps, spec, problem: null };
    return;
  }
  finishSpecTask(state, task, request);
}

// The spec task's spec is closed, or it has none (ADR 0013): spec-closed
// holds, and it is Done. Its branch goes with its worktree once a ticket
// task merged, carrying its docs to the base branch; else it is kept, as
// the only copy of them.
function finishSpecTask(state: Lifecycle, task: Task, request: AttentionRequest | undefined, { specOpen = false } = {}): void {
  if (!specOpen) task.ticketSet!.closed = true;
  finishRoot(task, request, { merged: true });
  const merged = Object.values(task.ticketSet!.launched).some((id) => state.tasks[id]?.state === 'done');
  if (task.cleanup && !merged) task.cleanup.keepBranch = true;
}

// The ticket task the spec task launches on `ticket` (ADR 0013), but for
// its id and first message: a root on the spec task's frozen stages from
// its tickets stage on, with its source, hash and base commit, which takes
// the spec task's handoff fields, skill set and merge policy, and a frozen
// copy of its per-task rules and egress hosts.
function launchedTicketTask(spec: Task, { ticket, title, worktree, sessionId }: TicketTaskLaunched, at: number): Task {
  const preset = spec.preset!;
  const from = preset.stages.findIndex(({ id }) => id === spec.stage);
  const stages = preset.stages.slice(from);
  // On a ready-for-human ticket, the ticket task is HITL: Ready for you,
  // holding no slot, and handed off at the spec task's level. Only frontier
  // tickets of the last read, none held back, are launched.
  const issue = spec.ticketSet!.issues.find(({ ref }) => ref === ticket);
  const mode = issue && ticketMode(issue) === 'HITL' ? 'HITL' : 'AFK';
  return {
    id: '',
    title,
    kind: 'ticket',
    ticket,
    specTask: spec.id,
    mergePolicy: policyOf(spec),
    repo: spec.repo,
    mode,
    autonomy: mode === 'AFK' ? (spec.autonomy ?? 'L1') : null,
    priority: spec.priority ?? 'normal',
    maxTurns: spec.maxTurns ?? null,
    groups: [...spec.groups],
    goal: null,
    operatorTier: spec.operatorTier ?? spec.inputs?.tier ?? null,
    worktree: { ...worktree },
    skillSet: spec.skillSet,
    preset: { ...structuredClone(preset), stages: structuredClone(stages) },
    stage: spec.stage,
    inputs: { prompt: spec.inputs?.prompt ?? '', issues: [ticket], issueKinds: artifactKindsIn(stages[0]!) },
    sessionId,
    runIds: [],
    state: 'queued',
    createdAt: at,
    allowRules: [...(spec.allowRules ?? [])],
    egressHosts: [...(spec.egressHosts ?? [])],
  };
}

// What a spec task's ticket task first opens on (ADR 0013): its stage's
// skill on its ticket, then the factory context it works in (the spec, the
// handoff brief, and where each sibling ticket stands), and the launch
// prompt, if any, as the operator's instructions.
function specTicketOpening(state: Lifecycle, spec: Task, ticketTask: Task): string {
  const stage = stageOf(ticketTask, ticketTask.stage)!;
  const set = spec.ticketSet!;
  const ticket = ticketTask.ticket!;
  const siblings = set.issues.filter(({ ref }) => ref !== ticket).map((issue) => `  - ${issue.ref}, ${issue.title}: ${siblingState(state, set, issue)}`);
  const facts = [
    ...(set.spec ? [`- Spec: ${set.spec}`] : []),
    ...(siblings.length ? ['- Sibling tickets:', ...siblings] : []),
  ];
  const context = [
    '## Factory context',
    `This task, ${ticketTask.id}, is a ticket task of the spec task ${spec.id}, ${spec.title}. Work on ${ticket} alone, on the task ` +
      `branch ${ticketTask.worktree!.branch}: its PR closes ${ticket} once merged. Sibling tickets are other tasks’ work: don’t start them.`,
    ...(facts.length ? [facts.join('\n')] : []),
    ...(spec.brief ? [spec.brief] : []),
  ];
  const prompt = spec.inputs?.prompt.trim();
  return [`/factory:${stage.skill} ${ticket}`, context.join('\n\n'), ...(prompt ? [`## Operator instructions\n${prompt}`] : [])].join('\n\n');
}

// Why a spec task waits on the operator once only held-back tickets are
// left: each one with its labels, and what moves it on.
function heldBackReason(task: Task, held: Issue[]): string {
  return (
    `${task.stage} has only held-back tickets left: ${listed(held.map((issue) => heldBackLabel(issue)))}. ` +
    `Label one ${READY_FOR_AGENT} or ${READY_FOR_HUMAN} on GitHub, then answer to read the tickets again.`
  );
}

// Why a spec task waits on the operator once it can launch no more tickets
// but its skipped ones: each skipped ticket, the open tickets they leave
// waiting, any held back, and what the operator can do.
function skippedReason(task: Task, skipped: Issue[], held: Issue[]): string {
  const refs = skipped.map(({ ref }) => ref);
  const waiting = task.ticketSet!.issues.filter((issue) => issue.open && !refs.includes(issue.ref) && issue.openBlockers.some((ref) => refs.includes(ref)));
  const one = refs.length === 1;
  const waits = waiting.length
    ? `, and ${listed(waiting.map(({ ref }) => ref))} ${waiting.length === 1 ? 'waits' : 'wait'} on ${one ? 'it' : 'them'}`
    : '';
  const heldBack = held.length ? ` ${listed(held.map((issue) => heldBackLabel(issue)))} ${held.length === 1 ? 'is' : 'are'} held back.` : '';
  const spec = task.ticketSet!.spec;
  const choices = spec ? `Relaunch a skipped ticket, end leaving ${spec} open, or close it anyway.` : 'Relaunch a skipped ticket, or end.';
  return (
    `${task.stage} can launch no more tickets: ${listed(refs)} ${one ? 'was' : 'were'} skipped when ${one ? 'its ticket task was' : 'their ticket tasks were'} cancelled${waits}.` +
    `${heldBack} ${choices}`
  );
}

// The items, joined as a sentence lists them.
function listed(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
}

// Why the answer can't stand on a spec task's request about its skipped
// tickets, null when it can, or undefined when neither is about them.
function skippedAnswerRefusal(task: Task, request: AttentionRequest, action: Extract<OperatorCommand, { type: 'answer' }>): string | null | undefined {
  const chose = action.relaunch !== undefined || action.end !== undefined;
  if (!request.skipped) return chose ? `${task.id} isn’t asking about skipped tickets: there is nothing to relaunch or end.` : undefined;
  if (action.relaunch !== undefined && action.end !== undefined) return 'Relaunch a skipped ticket, or end: not both.';
  if (action.relaunch !== undefined) {
    return request.skipped.includes(action.relaunch) && task.ticketSet?.skipped?.includes(action.relaunch) ? null : `${String(action.relaunch)} isn’t a skipped ticket of ${task.id}.`;
  }
  if (action.end !== undefined) {
    if (!SPEC_ENDS.includes(action.end)) return 'End leaving the spec open, or closing it anyway.';
    return action.end === 'close-spec' && !task.ticketSet?.spec ? `${task.id} has no spec to close: end it.` : null;
  }
  return `${task.id} can launch no more tickets: relaunch a skipped ticket, end leaving its spec open, or close it anyway.`;
}

// The operator answered a spec task's request about its skipped tickets:
// a relaunched ticket is skipped no more, and the spec task reads its
// tickets again to launch it; an ended spec task is Done, closing its spec
// first if the operator closes it anyway.
function answerSkipped(state: Lifecycle, task: Task, request: AttentionRequest, action: Extract<OperatorCommand, { type: 'answer' }>): void {
  const set = task.ticketSet!;
  if (action.relaunch) {
    const ticket = action.relaunch;
    set.skipped = (set.skipped ?? []).filter((ref) => ref !== ticket);
    delete set.launched[ticket];
    oweRead(set);
    task.state = 'running';
  } else if (action.end === 'close-spec') {
    set.closing = { problem: null, anyway: true };
    task.state = 'running';
  } else {
    finishSpecTask(state, task, request, { specOpen: true });
  }
}

// Where a sibling ticket stands for a ticket task's context: closed, in
// flight on its ticket task (or about to be), or waiting.
function siblingState(state: Lifecycle, set: TicketSet, issue: Issue): string {
  if (!issue.open) return 'closed';
  const launched = set.launched[issue.ref];
  if (launched) return `in flight (${launched}, ${label(state.tasks[launched]!)})`;
  if (set.toLaunch.includes(issue.ref)) return 'in flight';
  return issue.openBlockers.length ? `waiting on ${issue.openBlockers.join(', ')}` : 'waiting';
}

// What the factory read of a work loop's map: with no open ticket left the
// map has cleared, and the operator chooses where the task goes next;
// otherwise they are offered its frontier, the open tickets with no open
// blockers in sub-issue order. Every open ticket blocked, the loop stalls.
function readMap(state: Lifecycle, task: Task, { tickets, sessionId }: Extract<LoopEvent, { type: 'mapRead' }>, at: number): void {
  const stage = stageOf(task, task.stage)!;
  const last = lastRun(state, task);
  const open = tickets.filter((ticket) => ticket.open);
  if (open.length === 0) {
    task.loop = workLoop({ ticket: null, cleared: true });
    return;
  }
  const frontier = open.filter((ticket) => ticket.openBlockers.length === 0);
  if (frontier.length === 0) {
    const blocked = open.map(({ ref, openBlockers }) => `${ref} by ${openBlockers.join(', ')}`).join('; ');
    raise(state, task, last, 'stage-blocked', false, `${stage.id}’s map has no frontier: every open ticket is blocked (${blocked}).`, at);
    return;
  }
  task.loop = workLoop({ ticket: null, frontier: frontier.map(({ ref, title }) => ({ ref, title })), session: sessionId });
}

// What a work loop's run on a ticket of its map opens on: its stage's skill
// on the map and that ticket, and the factory context it works in.
function workOpening(state: Lifecycle, task: Task, { ref, title }: FrontierTicket): string {
  const stage = stageOf(task, task.stage)!;
  const filled = fillOpening(stage, (variable) => argValue(state, task, variable) ?? '');
  const opening = 'opening' in filled ? filled.opening : `/factory:${stage.skill}`;
  const context =
    `This run works one ticket of the map with the operator: ${ref}, ${title}. Resolve that ticket alone, and don’t start another. ` +
    'Once it is resolved, the operator advances, and the factory reads the map again for its next frontier.';
  return `${opening} ${ref}\n\n## Factory context\n${context}`;
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

// The stage an AFK stage leads to, or null past the last: a stage that
// requires L2 (such as open-pr) is skipped below it.
function nextAfkStage(task: Task, from: Stage): Stage | null {
  const { stages } = task.preset!;
  return stages.slice(stages.indexOf(from) + 1).find((stage) => !stage.requires || atLeast(task.autonomy, stage.requires)) ?? null;
}

// Where the advance sheet's confirm takes the task: past its stage and the
// optional ones it skips, to the next HITL stage, or past the last stage
// (null). An AFK stage next is the handoff's to start.
// At a work loop, confirming finishes the ticket its live run works,
// and the factory reads the map again. Once the map cleared, it leaves the
// loop: on to the next stage, jumping over it (`skip` names it, optional or
// not: the stage `jumped`), or, with `end`, to the end.
type AdvancePlan =
  | { kind: 'advance'; from: Stage; to: Stage | null; jumped: Stage | null }
  | { kind: 'finish-ticket'; from: Stage }
  | { kind: 'end'; from: Stage };

function planAdvance(state: Lifecycle, task: Task, skip: string[], end = false): AdvancePlan | { refusal: string } {
  const { stages } = task.preset!;
  const at = stages.findIndex(({ id }) => id === task.stage);
  const from = stages[at]!;
  const cleared = atWorkLoop(task) && !!task.loop!.cleared;
  if (atWorkLoop(task) && !cleared) {
    if (!task.loop!.ticket) return { refusal: `${task.id} works no ticket of its map yet: pick one from its frontier first.` };
    if (skip.length || end) return { refusal: `${task.id}’s map hasn’t cleared: finish ${task.loop!.ticket} first.` };
    return { kind: 'finish-ticket', from };
  }
  if (end) return cleared ? { kind: 'end', from } : { refusal: `Only a cleared map ends ${task.id} early.` };
  let next = at + 1;
  for (; next < stages.length && skip.includes(stages[next]!.id); next++) {
    // A cleared map may jump over the stage after it.
    if (!stages[next]!.optional && !(cleared && next === at + 1)) return { refusal: `${stages[next]!.id} isn’t optional, so it can’t be skipped.` };
  }
  const to = stages[next] ?? null;
  const between = stages.slice(at + 1, next).map(({ id }) => id);
  const stray = skip.find((id) => !between.includes(id));
  if (stray) return { refusal: `${stray} isn’t a stage between ${from.id} and ${to?.id ?? 'the end'}.` };
  const unmet = unmetExit(state, task, from);
  if (unmet) return { refusal: unmet };
  if (to?.mode === 'AFK') return { refusal: `The next stage, ${to.id}, is AFK: hand ${task.id} off to start it.` };
  return { kind: 'advance', from, to, jumped: cleared && next > at + 1 ? stages[at + 1]! : null };
}

// The args value of a stage a cleared map jumped to: the map stands in for
// the artifact the stage it jumped over would have made (wayfinder's
// tickets are written from the map when the spec is jumped over).
function jumpValue(state: Lifecycle, task: Task, jumped: Stage | null, variable: string): string | null {
  const value = argValue(state, task, variable);
  if (value !== null || !jumped?.exit?.startsWith('artifact:')) return value;
  return variable === `artifacts.${jumped.exit.slice('artifact:'.length)}` ? issuesFor(state, task, 'map').join(' ') || null : null;
}

// The live runs whose park deadline has passed at `at`.
export function overdueRuns(state: Lifecycle, at: number): Run[] {
  return Object.values(state.runs).filter((run) => run.status !== 'ended' && run.parksAt !== null && run.parksAt <= at);
}

export function activeAfkRuns(state: Lifecycle): number {
  return Object.values(state.runs).filter((run) => run.status === 'active' && run.mode === 'AFK').length;
}

// Whether a live run waits on the operator: its turn, or a card it asked.
export function waitsOnOperator(run: Run): boolean {
  return run.status === 'active' && (run.turn === 'operator' || run.question !== null || !!run.permission);
}

// The permission the task's `answer` decides: its open permission request's
// while it shows one, or else its HITL run's card, if any.
export function openPermission(state: Lifecycle, task: Task): Permission | null {
  const request = showsRequest(task) ? openRequest(state, task) : undefined;
  return request ? (request.permission ?? null) : openCard(state, task);
}

// The card the task's live HITL run waits on for a tool call, which the
// task's `answer` decides while it shows no request, if any.
export function openCard(state: Lifecycle, task: Task): Permission | null {
  if (task.mode !== 'HITL' || (showsRequest(task) && openRequest(state, task))) return null;
  return liveRun(state, task)?.permission ?? null;
}

// A HITL task whose turn is the operator's: queued for its conversation, or
// in one that waits on them while no TUI has it open (`watched` holds the
// runs whose conversations are open).
export function readyForYou(state: Lifecycle, task: Task, watched: ReadonlySet<string>): boolean {
  if (task.mode !== 'HITL') return false;
  // A work loop's frontier is offered once the factory read its map.
  if (task.state === 'queued') return !readingMap(state, task);
  const run = task.state === 'running' ? liveRun(state, task) : undefined;
  return !!run && waitsOnOperator(run) && !watched.has(run.id);
}

// `ready` is what `readyForYou` says of the task.
export function label(task: Task, ready = false): string {
  switch (task.state) {
    case 'draft':
      return 'Draft';
    case 'queued':
      if (task.mode === 'AFK') return 'Queued';
      return awaitsMapRead(task) ? 'Reading the map' : 'Ready for you';
    case 'running':
      if (task.mode === 'AFK') return 'Running';
      return ready ? 'Ready for you' : 'In conversation';
    case 'waiting':
      return 'Needs you';
    case 'awaiting-children':
      return 'Waiting on children';
    case 'in-review':
      return atMergeGate(task) ? 'At merge gate' : 'In review';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
  }
}

export type AttentionQueueItem =
  | {
      kind: 'attention';
      taskId: string | null;
      repo: string | null;
      requestId: string;
      attention: AttentionKind;
      holdsRun: boolean;
      reason: string | null;
      question: Question | null;
      permission: Permission | null;
      recovery: Recovery | null;
      deniedHosts: string[] | null;
      skipped: string[] | null;
    }
  | { kind: 'ready'; taskId: string }
  | { kind: 'review'; taskId: string };

const attentionItem = ({ taskId, repo, id, kind, holdsRun, reason, question = null, permission = null, recovery = null, deniedHosts = null, skipped = null }: AttentionRequest): AttentionQueueItem => ({
  kind: 'attention',
  taskId,
  repo,
  requestId: id,
  attention: kind,
  holdsRun,
  reason,
  question,
  permission,
  recovery: structuredClone(recovery),
  deniedHosts: deniedHosts && [...deniedHosts],
  skipped: skipped && [...skipped],
});

// Whether the task's open request, if any, waits on the operator: a task
// Needs you's, a cancelled task's (its cancel cascade's), and a root in
// review's (its Push & open draft PR's).
function showsRequest(task: Task): boolean {
  return task.state === 'waiting' || task.state === 'cancelled' || task.state === 'in-review' || (task.state === 'done' && !!task.child?.research?.step);
}

// Everything waiting on the operator, the most urgent first: failures, then
// the other requests (those about repositories included), each oldest first,
// then HITL tasks ready for the operator, then root tasks in review.
export function attentionQueue(state: Lifecycle, watched: ReadonlySet<string> = new Set()): AttentionQueueItem[] {
  const requests: AttentionRequest[] = [];
  const ready: AttentionQueueItem[] = [];
  const reviews: AttentionQueueItem[] = [];
  const report = recoveryReport(state);
  if (report) requests.push(report);
  for (const repository of Object.values(state.repositories)) {
    const request = openRepoRequest(state, repository.id);
    if (request) requests.push(request);
  }
  for (const task of Object.values(state.tasks)) {
    const request = openRequest(state, task);
    if (showsRequest(task) && request) requests.push(request);
    if (readyForYou(state, task, watched)) ready.push({ kind: 'ready', taskId: task.id });
    // A root at an agent policy's merge gate is the factory's to merge.
    if (task.state === 'in-review' && !atMergeGate(task)) reviews.push({ kind: 'review', taskId: task.id });
  }
  const failure = (request: AttentionRequest) => Number(request.kind === 'failure');
  requests.sort((a, b) => failure(b) - failure(a) || a.raisedAt - b.raisedAt);
  return [...requests.map(attentionItem), ...ready, ...reviews];
}

// ---- Reducer ----

function taskOf(state: Lifecycle, action: LifecycleAction): Task | undefined {
  if ('taskId' in action) return state.tasks[action.taskId];
  if ('runId' in action) {
    const run = state.runs[action.runId];
    return run && state.tasks[run.taskId];
  }
  return undefined;
}

// Why an action is illegal right now, or null.
export function guard(state: Lifecycle, action: LifecycleAction): string | null {
  if ('taskId' in action && !state.tasks[action.taskId]) return `There is no task ${action.taskId}.`;
  if ('runId' in action) {
    const run = state.runs[action.runId];
    if (!run) return `There is no run ${action.runId}.`;
    if (action.type === 'permissionAsked' && (run.status === 'suspended' || (run.status === 'active' && run.permission))) {
      // The task's rules still decide the other calls of a run that waits
      // on a request, or on a HITL run's card.
      if (!grantFor(state.tasks[run.taskId]!, run, action)) return 'Another request of this run is waiting on the operator.';
    } else if (run.status !== 'active' && !(run.status === 'suspended' && action.type === 'runFailed') && !isMetering(action) && action.type !== 'usageSnapshotSeen') {
      // A suspended run can still fail: its CLI may exit while it waits on
      // the operator. What a run spent is metered, and what it saw of the
      // usage windows kept, whenever it says.
      return `Run ${run.id} is not active.`;
    }
  }
  if ('repo' in action && action.type !== 'repoRegistered' && !state.repositories[action.repo]) {
    return `${action.repo} is not registered.`;
  }
  const task = taskOf(state, action)!;
  switch (action.type) {
    case 'createTask':
      if (!action.title.trim()) return 'A task needs a title.';
      return action.priority === undefined ? null : priorityRefusal(action.priority);
    case 'taskLaunched':
      // Which launch inputs it needs is its start stage's to say.
      if (action.operatorTier !== null && !isTier(action.operatorTier)) return tierRefusal(action.operatorTier);
      if (action.maxTurns !== null && !(Number.isInteger(action.maxTurns) && action.maxTurns >= 1)) {
        return 'Max turns must be a whole number of at least 1.';
      }
      if (!AUTONOMY_LEVELS.includes(action.autonomy)) return `${action.autonomy} is not an autonomy level (${LEVELS_TEXT}).`;
      if (state.repositories[action.repo]!.missing) return `${action.repo} is missing, so its runs can’t start.`;
      // The level counts only for a task starting AFK, at a stage its preset names once resolved.
      const startsAfk = action.preset?.stages.find(({ id }) => id === action.stage)?.mode === 'AFK';
      if (startsAfk) {
        const refused = levelRefused(state, action.repo, action.autonomy);
        if (refused) return refused;
      }
      // Frozen only on a task starting AFK; one starting HITL picks it at its handoff.
      if (action.mergePolicy !== undefined) {
        const refused = policyRefusal(action.mergePolicy, startsAfk || !action.preset ? action.autonomy : null);
        if (refused) return refused;
      }
      if (action.quick && action.preset && action.preset.stages.find(({ id }) => id === action.stage)?.mode !== 'HITL') {
        return `A quick launch grills you first, but ${action.preset.name} starts at an AFK stage (${action.stage}).`;
      }
      return priorityRefusal(action.priority);
    case 'removeRepo': {
      const unfinished = unfinishedTasks(state, action.repo);
      if (unfinished.length) return `${action.repo} has unfinished tasks (${unfinished.map((task) => task.id).join(', ')}). Finish or cancel them first.`;
      const cleaning = Object.values(state.tasks).filter((task) => task.repo === action.repo && task.cleanup);
      return cleaning.length ? `The factory is still cleaning up after ${cleaning.map((task) => task.id).join(', ')} in ${action.repo}.` : null;
    }
    case 'submit':
      return task.state === 'draft' ? null : 'Only a draft can be submitted.';
    case 'open':
      if (task.mode !== 'HITL') return `${task.id} is AFK. Take it over to talk to it.`;
      if (task.state !== 'draft' && task.state !== 'queued') return `${task.id} isn't ready for a conversation (it is ${label(task)}).`;
      if (readingMap(state, task)) return `The factory is reading ${task.id}’s map: its frontier shows once it has.`;
      if (task.loop?.cleared && atWorkLoop(task)) return `${task.id}’s map has cleared: choose where it goes next.`;
      if (action.ticket !== undefined) {
        if (!picksFromFrontier(task)) return `${task.id} isn’t picking a ticket from a map’s frontier.`;
        if (!task.loop!.frontier!.some(({ ref }) => ref === action.ticket)) return `${action.ticket} isn’t on ${task.id}’s frontier.`;
      }
      return cantStartRuns(state, task);
    case 'sendMessage':
      if (task.mode === 'AFK') return takesNoChat(task);
      if (!action.text.trim()) return 'A message needs text.';
      if (task.handoff) return sheetOpen(task);
      return liveRun(state, task)?.status === 'active' ? null : `${task.id} has no live conversation.`;
    case 'interrupt': {
      if (task.mode === 'AFK') return takesNoChat(task);
      const run = liveRun(state, task);
      if (run?.status !== 'active') return `${task.id} has no live conversation.`;
      return run.turn === 'agent' ? null : `${task.id}’s agent isn’t mid-turn.`;
    }
    case 'answerQuestion': {
      const { question } = liveRun(state, task) ?? {};
      if (question?.id !== action.questionId) return 'That question is no longer open.';
      const answered = question.questions.every(({ question }) => action.answers[question]?.trim());
      return answered ? null : 'Answer every question on the card.';
    }
    case 'readinessRead':
      return task.handoff ? null : `${task.id} has no handoff sheet open.`;
    case 'handedOff': {
      if (!task.handoff) return `${task.id} has no handoff sheet open.`;
      if (!task.handoff.brief) return 'The agent hasn’t written the brief yet: you confirm the brief you have read.';
      if (!tidyBrief(action.brief).goal) return 'The brief needs a goal.';
      if (!CONTINUE_AS.includes(action.continueAs)) return 'Continue as resume, or fresh from the brief.';
      if (!AUTONOMY_LEVELS.includes(action.autonomy)) return `${action.autonomy} is not an autonomy level (${LEVELS_TEXT}).`;
      const refused = levelRefused(state, task.repo, action.autonomy) ?? policyRefusal(policyOf(action), action.autonomy);
      if (refused) return refused;
      if (!isTier(action.tier)) return tierRefusal(action.tier);
      if (!(Number.isInteger(action.maxTurns) && action.maxTurns >= 1)) return 'Max turns must be a whole number of at least 1.';
      return specsRefusal(task.handoff, action.specs ?? []);
    }
    case 'closeHandoff':
      return task.handoff ? null : `${task.id} has no handoff sheet open.`;
    case 'expandQuickLaunch':
      return task.quick ? null : `${task.id} is no quick launch, or is one no longer.`;
    case 'takeOver':
      if (!(task.mode === 'AFK' && ['queued', 'running', 'waiting'].includes(task.state))) return 'Only a live AFK task (queued, running or needing you) can be taken over.';
      return atRetiredLoop(task) ? retiredLoopReason(task, stageOf(task, task.stage)!) : cantStartRuns(state, task);
    case 'answer': {
      const request = showsRequest(task) ? openRequest(state, task) : undefined;
      // A HITL run's card takes only a permission answer.
      if (openCard(state, task)) return permissionRefusal(action.permission, true);
      if (!request) return `${task.id} has no open attention request.`;
      const refused = permissionRefusal(action.permission, !!request.permission);
      if (refused) return refused;
      // Requests stored before they named their call have no rule to add.
      if (allowsByRules(action.permission) && action.permission.allow === 'always' && !request.permission) {
        return 'This request doesn’t name its call: allow it once or for this task.';
      }
      if (request.kind === 'pr-closed-unmerged') return `${task.id}’s PR was closed without merging: cancel the task, or reopen its PR.`;
      // Only cancelling, to relaunch, carries a task on from the retired Ralph loop.
      if (request.kind === 'stage-blocked' && atRetiredLoop(task)) return retiredLoopReason(task, stageOf(task, task.stage)!);
      const skippedRefusal = skippedAnswerRefusal(task, request, action);
      if (skippedRefusal !== undefined) return skippedRefusal;
      if (action.allowHosts !== undefined) {
        const hosts = request.kind === 'failure' ? (request.deniedHosts ?? []) : [];
        if (hosts.length === 0) return `${task.id}’s run was denied no egress: there is no host to allow.`;
        if (!Array.isArray(action.allowHosts) || action.allowHosts.length === 0) return `Name the hosts to allow: ${hosts.join(', ')}.`;
        const other = action.allowHosts.find((host) => !hosts.includes(host));
        if (other !== undefined) return `${task.id}’s run wasn’t denied ${String(other)}: allow only ${hosts.join(', ')}.`;
      }
      const answered = request.question?.questions.every(({ question }) => action.answers?.[question]?.trim()) ?? true;
      return answered ? null : 'Answer every question on the card.';
    }
    case 'requestChanges':
      if (task.state !== 'in-review') return `${task.id} is not in review.`;
      return (
        publishingRefusal(task) ??
        mergingRefusal(task) ??
        (typeof action.comments === 'string' && action.comments.trim() ? null : 'Request changes needs your review comments: say what to change.')
      );
    case 'markDone':
      return task.state === 'in-review' ? (publishingRefusal(task) ?? mergingRefusal(task)) : `${task.id} is not in review.`;
    case 'pushAndOpenPr':
      if (task.state !== 'in-review') return `${task.id} is not in review.`;
      if (publishesCode(task.autonomy)) return `${task.id} is at ${task.autonomy}, where the factory opens its draft PR itself.`;
      // HITL work acts as the operator (ADR 0004): the App publishes only L1
      // work here. A setup task is published unasked when it reaches review
      // (ADR 0010), never through this button.
      if (task.autonomy !== 'L1') return `${task.id} is HITL work, which stays yours: push its branch and open its PR yourself.`;
      return task.publishing ? `${task.id} is already pushing and opening its draft PR.` : null;
    case 'reopenPr':
      if (task.state !== 'in-review') return `${task.id} is not in review.`;
      return openRequest(state, task)?.kind === 'pr-closed-unmerged' ? null : `${task.id}’s PR isn’t closed unmerged.`;
    case 'prRead':
      if (!waitsOnPr(task)) return `${task.id} isn’t in review with a PR.`;
      return publishingRefusal(task) ?? mergingRefusal(task);
    case 'prMarkedReady':
    case 'prMerged':
    case 'mergeFailed': {
      const step = action.type === 'mergeFailed' ? action.step : MERGE_STEPS.find((each) => MERGE_STEP_DONE[each] === action.type)!;
      return atMergeGate(task) && task.gate?.step === step ? null : `${task.id} isn’t at its merge gate’s ${step} step.`;
    }
    case 'cancel':
      if (action.branch !== undefined && !BRANCH_CHOICES.includes(action.branch)) return 'Keep the branch, or discard the work.';
      if (isTerminal(task)) return `${task.id} is already ${label(task)}.`;
      return mergingRefusal(task);
    case 'retier':
      if (!isTier(action.tier)) return tierRefusal(action.tier);
      return isTerminal(task) ? `${task.id} is already ${label(task)}.` : null;
    case 'setAutonomy': {
      if (!AUTONOMY_LEVELS.includes(action.autonomy)) return `${action.autonomy} is not an autonomy level (${LEVELS_TEXT}).`;
      if (task.mode !== 'AFK') return `${task.id} is HITL, so it has no autonomy level.`;
      if (isTerminal(task)) return `${task.id} is already ${label(task)}.`;
      const refused = levelRefused(state, task.repo, action.autonomy);
      if (refused) return refused;
      // A run's containment never shifts under it.
      const run = liveRun(state, task);
      return run ? `${task.id}’s autonomy level changes only between runs, and its run ${run.id} is live.` : null;
    }
    case 'setSlotCap':
      return Number.isInteger(action.cap) && action.cap >= 1 ? null : 'The slot cap must be a whole number of at least 1.';
    case 'setKeepAwake':
      return typeof action.on === 'boolean' ? null : 'Keep-awake is either on or off.';
    case 'dismiss': {
      const request = state.requests[action.requestId];
      if (!request) return `There is no attention request ${action.requestId}.`;
      if (request.kind !== 'recovery-report') return 'Only the Factory recovered report can be dismissed.';
      return request.status === 'open' ? null : 'That report is already dismissed.';
    }
    case 'runStarted':
    case 'runCompleted':
    case 'runFailed':
    case 'turnEnded':
    case 'usageSampled':
    case 'usageTotaled':
    case 'usageSnapshotSeen':
      return null;
    case 'windowWaited':
      return task.mode === 'AFK' ? null : 'Only an AFK run waits out a usage limit.';
    case 'findingsReported':
      return runReports(task, state.runs[action.runId]!).includes('findings') ? null : 'Only a run of a fix-once review stage reports findings.';
    case 'prBodyWritten':
      return runReports(task, state.runs[action.runId]!).includes('pr-body') ? null : 'Only a run of a stage whose exit is artifact:pr-body writes the PR body.';
    case 'artifactsSeen':
      return isTerminal(task) ? `${task.id} is already ${label(task)}.` : null;
    case 'childSpawned':
      return spawnRefusal(state, task, state.runs[action.runId]!, action);
    case 'progressReported':
      if (task.mode !== 'AFK') return 'Only an AFK run reports its progress.';
      return action.status.trim() ? null : 'A status needs text.';
    case 'resultReported':
      if (!task.child) return `${task.id} is no child task: it has no parent to report to.`;
      return action.summary.trim() ? null : 'A result needs a summary.';
    case 'childCancelled': {
      const child = state.tasks[action.childId];
      if (child?.parent !== task.id) return `${action.childId} isn’t a child of ${task.id}: you may cancel only your own children.`;
      return isTerminal(child) ? `${child.id} is already ${label(child)}.` : null;
    }
    case 'questionAsked':
      return task.mode === 'HITL' ? null : 'In an AFK run a question is an attention request.';
    case 'advanceProposed':
      return task.mode === 'HITL' ? null : 'Only a HITL run proposes advancing; AFK stages advance on their own.';
    case 'handoffProposed':
    case 'briefWritten':
      return task.mode === 'HITL' ? null : `${task.id} is AFK already.`;
    case 'handoffOpened': {
      if (task.mode !== 'HITL' || (task.state !== 'running' && task.state !== 'queued')) {
        return `Only a HITL task in conversation or ready for you can be handed off (${task.id} is ${label(task)}).`;
      }
      if (task.runIds.length === 0) return `There is nothing to hand off yet: ${task.id} has had no conversation.`;
      // The operator may have expanded it meanwhile.
      if (action.quick && !task.quick?.done) return `${task.id}’s quick launch no longer ends on its handoff sheet.`;
      const to = handoffStage(task);
      if (to?.kind === 'action') return `The next AFK stage, ${to.id}, is a factory action, which the factory can’t run yet.`;
      return liveRun(state, task) ? null : cantStartRuns(state, task);
    }
    case 'stageAdvanced': {
      if (!task.preset || !task.stage) return `${task.id} follows no workflow preset.`;
      if (task.handoff) return sheetOpen(task);
      if (task.mode !== 'HITL' || (task.state !== 'running' && task.state !== 'queued')) {
        return `Only a HITL task in conversation or ready for you advances its stage (${task.id} is ${label(task)}).`;
      }
      const plan = planAdvance(state, task, action.skip, action.end);
      if ('refusal' in plan) return plan.refusal;
      return plan.kind === 'advance' && plan.to ? cantStartRuns(state, task) : null;
    }
    case 'attentionRaised':
      return task.mode === 'HITL' ? 'In a HITL run the agent asks in the conversation, not with an attention request.' : null;
    case 'permissionAsked':
      // A HITL run's call shows as a card in the conversation.
      return null;
    case 'repoRegistered': {
      const registered = state.repositories[action.repo];
      return registered ? `${action.repo} is already registered at ${registered.path}.` : null;
    }
    case 'repoMissing':
    case 'repoFound':
    case 'repoMoved':
    case 'appChecked':
    case 'skillsChecked':
    case 'deadlinesDue':
    case 'runsReconciled':
      return null;
    case 'intentJournaled':
      return state.intents[action.intent.id] ? `${task.id}’s ${action.intent.verb} is already under way.` : null;
    case 'intentDropped':
      return state.intents[action.intentId] ? null : `There is no intent ${action.intentId}.`;
    case 'mapRead':
      return readingMap(state, task) ? null : `${task.id} isn’t reading a map.`;
    case 'ticketsUnread':
      return readingMap(state, task) ? null : `${task.id} isn’t reading a map.`;
    case 'setupCommitted':
      return task.publishing?.step === 'commit' ? null : `${task.id} isn’t committing its setup.`;
    case 'branchPushed':
    case 'pushRefused':
      return task.publishing?.step === 'push' ? null : `${task.id} isn’t pushing its task branch.`;
    case 'publishFailed':
      return task.publishing?.step === action.step ? null : `${task.id} isn’t at ${action.step}.`;
    case 'prOpened':
      // A PR opened is the task's however it stands now, even cancelled.
      return null;
    case 'cleanedUp':
    case 'cleanupFailed':
      return task.cleanup ? null : `${task.id} has no cleanup under way.`;
    case 'researchPushed':
    case 'researchPushRefused':
      return task.child?.research?.step === 'push' ? null : `${task.id} isn’t pushing its research branch.`;
    case 'researchClosed':
      return task.child?.research?.step === 'close' ? null : `${task.id} isn’t closing its research ticket.`;
    case 'researchFailed':
      return task.child?.research?.step === action.step ? null : `${task.id} isn’t at ${action.step}.`;
    case 'ticketResolved':
    case 'ticketUnresolved':
      return task.resolving ? null : `${task.id} owes no ticket its closing.`;
    case 'specClosed':
    case 'specUnclosed':
      return task.ticketSet?.closing && !isTerminal(task) ? null : `${task.id} isn’t closing its spec.`;
    case 'mapClosed':
    case 'mapUnclosed':
      // Owed even once the task ended: one ended at its cleared map is In
      // review, and may be Done or cancelled before its map closes.
      return task.mapClosing ? null : `${task.id} isn’t closing its map.`;
    case 'ticketSetRead':
    case 'ticketSetUnread':
      return task.ticketSet?.reading && !isTerminal(task) ? null : `${task.id} isn’t reading a ticket set.`;
    case 'ticketTaskUnlaunched':
      return task.ticketSet?.toLaunch.includes(action.ticket) ? null : `${task.id} isn’t launching a ticket task on ${action.ticket}.`;
    case 'ticketTaskLaunched': {
      const set = task.ticketSet;
      if (!set || isTerminal(task) || !set.toLaunch.includes(action.ticket)) return `${task.id} isn’t launching a ticket task on ${action.ticket}.`;
      // Its id is in its branch name, cut before it was launched.
      if (action.ticketTaskId !== nextTaskId(state)) return `The ticket task on ${action.ticket} would be ${nextTaskId(state)}, not ${action.ticketTaskId}.`;
      return state.repositories[task.repo]?.missing ? `${task.repo} is missing, so its runs can’t start.` : null;
    }
    case 'notesDelivered':
      if (!task.factoryNotes?.length) return `${task.id} holds no factory notes.`;
      const live = liveRun(state, task);
      return live?.status === 'active' && live.turn === 'operator' ? null : `${task.id}’s conversation isn’t on the operator’s turn.`;
    case 'childBranchDeleted':
      return keptChildBranches([task]).length ? null : `${task.id} keeps no child branch.`;
  }
}

// A root In review ends Done, its Push & open draft PR stopped: the daemon
// archives its transcripts, then removes its worktree and branch. Once its
// work is merged, the task branch the factory pushed goes too; a root
// finished anyway keeps it, as the only remote copy of work still unmerged.
function finishRoot(task: Task, request: AttentionRequest | undefined, { merged }: { merged: boolean }): void {
  const pushed = pushedBranch(task);
  stopPublishing(task, request);
  task.state = 'done';
  task.progress = null;
  if (task.worktree) task.cleanup = { problem: null, remote: merged && pushed ? { branch: pushed, prToClose: null } : null };
}

// The root's PR merged, by the operator or the factory: the root is Done
// (ADR 0011), whatever was left to ask. A ticket task's ticket closes with
// it: the factory closes it if GitHub left it open (ADR 0013).
function finishMerged(state: Lifecycle, task: Task, request: AttentionRequest | undefined): void {
  finishRoot(task, request, { merged: true });
  task.gate = null;
  if (task.kind === 'ticket' && task.ticket) task.resolving = { problem: null };
  oweTicketSetRead(state, task);
}

// The PR poll read the open PR of a root at its merge gate (ADR 0014): its
// gate takes the checks on its head, and once they are green, or the repo
// runs none, and GitHub finds it mergeable, the factory merges it, marking
// the draft ready first. No checks counts only once two reads of the same
// head both found none: right after a push, CI may not have registered its
// checks yet. Pending checks wait for the next read. Green ones spend its
// fix run no longer, even while a merge they let through is under way. Red
// ones, with nothing asked, get its one fix run, as a conflict gets an
// update run; red again after it raise a failure request naming the checks,
// and the root stays at its gate, unmerged, until the operator answers it
// and its gate is read afresh. A merge already under way is left to finish,
// and a failed step's problem stays while its request is open.
function readGate(state: Lifecycle, task: Task, read: PrReadEvent, request: AttentionRequest | undefined, at: number): void {
  if (!atMergeGate(task)) return;
  if (read.checks?.state === 'green') task.fixRun = null;
  if (task.gate?.step) return;
  if (!read.checks || !read.head) {
    task.gate = null;
    return;
  }
  const { state: checks, failed } = read.checks;
  const noneTwice = checks === 'none' && task.gate?.checks === 'none' && task.gate.head === read.head;
  const passes = (checks === 'green' || noneTwice) && read.mergeable === 'mergeable' && !request;
  if (read.draft !== undefined) task.pr!.draft = read.draft;
  const problem = request ? (task.gate?.problem ?? null) : null;
  task.gate = { checks, head: read.head, step: passes ? (task.pr!.draft ? 'ready' : 'merge') : null, problem };
  if (checks === 'red' && !request) fixRedChecks(state, task, read.head, failed, at);
}

// The checks on the head `head` of a root's PR at its merge gate are red,
// `failed` failing: its one fix run, resuming its session, or once that is
// spent, a failure request. A read of the head that queued the fix run, once
// the factory pushed something newer, is GitHub not caught up yet.
function fixRedChecks(state: Lifecycle, task: Task, head: string, failed: FailedCheck[], at: number): void {
  const { fixRun } = task;
  if (!fixRun) {
    task.fixRun = { redHead: head, pushed: null };
    task.resumeWith = checksFixOpening(task, failed);
    task.state = 'queued';
    return;
  }
  if (head === fixRun.redHead && fixRun.pushed && fixRun.pushed !== head) return;
  const named = failed.length ? `: ${failedChecksText(failed)}` : '';
  const reason = `The checks on PR #${task.pr!.number} of ${task.id} are still failing after its fix run${named}. Fix them and push to the task branch, then answer to send the task back to its merge gate.`;
  addRequest(state, task, lastRun(state, task), 'failure', false, reason, at);
}

// The failed checks, each with the page that says why, if any.
function failedChecksText(failed: FailedCheck[]): string {
  return failed.map(({ name, url }) => (url ? `${name} (${url})` : name)).join(', ');
}

// What the fix run on a root's PR whose checks went red opens on.
function checksFixOpening(task: Task, failed: FailedCheck[]): string {
  const which = failed.length
    ? `These checks failed: ${failedChecksText(failed)}. Each link is GitHub’s page for its check, with its log; a check without one is named as GitHub lists it.`
    : 'GitHub names no failed check.';
  return (
    `The checks on PR #${task.pr!.number} of ${task.id} failed on its head, so the factory can’t merge it. ${which} ` +
    'Unattended, find why: read those pages if your run can reach them, and run the same builds, tests and linters in the task’s worktree. ' +
    `Fix the cause, check the work still builds and passes its tests, and commit the fix to the task branch ${task.worktree!.branch}. ` +
    'The factory pushes it once your run ends, and the task goes back to its merge gate to wait on the new head’s checks. ' +
    'This is the task’s one fix run: if its checks fail again, the factory asks the operator. If you can’t fix them, end your run without committing.'
  );
}

// What a pr-closed-unmerged request tells the operator.
function prClosedReason(task: Task): string {
  return `PR #${task.pr!.number} of ${task.id} was closed without merging. Cancel the task, or reopen the PR.`;
}

// The root's Push & open draft PR stopped on `problem`: a github-write
// request asks the operator, and the root stays In review. At its open-pr
// stage it needs the operator instead.
function failPublishing(state: Lifecycle, task: Task, request: AttentionRequest | undefined, problem: string, at: number): void {
  task.publishing!.problem = problem;
  if (request) return;
  if (atActionStage(task)) raise(state, task, lastRun(state, task), 'github-write', false, problem, at);
  else addRequest(state, task, lastRun(state, task), 'github-write', false, problem, at);
}

// A root reaching In review after a run. At L2 and above the factory publishes what
// the run did unattended (ADR 0007): it pushes the task branch to the root's
// PR, or, with no PR yet, pushes and opens one if the preset has an open-pr
// stage, as when the operator took the root over before it opened. A setup
// task publishes at any level, HITL included (ADR 0010): it first commits
// the setup files its runs left, and opens no PR when its branch then has
// nothing the base branch lacks.
// A root whose merge policy is an agent one waits at its merge gate instead,
// once its PR is published (ADR 0014): its gate is read afresh.
function reachReview(task: Task): void {
  task.state = 'in-review';
  task.gate = null;
  if (task.child || !task.worktree) return;
  if (isSetupTask(task)) task.publishing = { step: 'commit', problem: null };
  else if (publishesCode(task.autonomy) && (task.pr || opensPr(task))) task.publishing = { step: 'push', problem: null };
}

// Whether the task runs the skill set's per-repo setup: its preset is the
// one "Set up now" launches (ADR 0010).
function isSetupTask(task: Task): boolean {
  return task.preset?.name === SETUP_PRESET;
}

// Whether the task's frozen preset has an open-pr stage.
function opensPr(task: Task): boolean {
  return !!task.preset?.stages.some((stage) => stage.kind === 'action' && stage.id === 'open-pr');
}

// Whether the AFK task is at a factory action stage, while the factory
// works it or a failed step of it needs the operator.
function atActionStage(task: Task): boolean {
  return task.mode === 'AFK' && stageOf(task, task.stage)?.kind === 'action' && (task.state === 'running' || task.state === 'waiting');
}

// The draft PR is open, or updated by the push: an open-pr stage moves on,
// past its last stage to In review.
function actionStagePublished(state: Lifecycle, task: Task, at: number): void {
  if (atActionStage(task)) advanceFrom(state, task, stageOf(task, task.stage)!, lastRun(state, task), undefined, at);
}

// The operator moved the root on without finishing its Push & open draft
// PR: the request a failed step raised has nothing left to ask.
function stopPublishing(task: Task, request: AttentionRequest | undefined): void {
  task.publishing = null;
  if (request) request.status = 'closed';
}

// Why the root can't be reviewed while its Push & open draft PR is under
// way, or null: a step that failed waits on the operator, so it isn't.
function publishingRefusal(task: Task): string | null {
  return task.publishing && !task.publishing.problem ? `${task.id} is pushing and opening its draft PR: wait for it to finish.` : null;
}

// Why the run can't spawn this child, or null. A HITL run spawns
// fire-and-forget children only (ADR 0009): its work never takes code from them.
function spawnRefusal(state: Lifecycle, task: Task, run: Run, spawn: ChildSpawned): string | null {
  if (run.mode === 'HITL' && spawn.awaited === true) {
    return 'A HITL run spawns fire-and-forget children only: spawn it without await, and its report reaches this conversation as a factory note.';
  }
  if (spawn.research) {
    if (spawn.awaited === true) return 'A research child is fire-and-forget: its findings go to its research branch, never into yours.';
    const badName = researchNameRefusal(spawn.research.name);
    if (badName) return badName;
    const ticket = spawn.research.ticket.split('#')[0];
    if (ticket !== task.repo) return `${spawn.research.ticket} isn’t a ticket of ${task.repo}, where the factory closes research tickets.`;
  }
  if (!task.worktree) return `${task.id} has no task branch to cut a child’s from.`;
  if (!spawn.goal.trim()) return 'A child needs a goal that stands on its own: it doesn’t see this conversation.';
  if (spawn.tier !== null && !isTier(spawn.tier)) return tierRefusal(spawn.tier);
  if (spawn.autonomy !== null && !AUTONOMY_LEVELS.includes(spawn.autonomy)) return `${spawn.autonomy} is not an autonomy level (${LEVELS_TEXT}).`;
  return spawnLimit(state, task);
}

// The task's awaited children whose reports it hasn't been handed yet: a
// run of it that ends while it has any waits on them (ADR 0009).
export function awaitedChildren(state: Lifecycle, task: Task): Task[] {
  return childrenOf(state, task).filter((child) => child.child?.awaited && !child.child.delivered);
}

// Whether the child the run spawns is awaited: as the agent asked from an
// AFK run, by default yes, and never from a HITL run (ADR 0009), nor a
// research child (ADR 0007).
function awaitsChild(run: Run, spawn: ChildSpawned): boolean {
  return run.mode === 'AFK' && !spawn.research && (spawn.awaited ?? true);
}

// Those of `tasks` that are ended children whose local branch is still
// kept once their worktree is gone: awaited children that ended Done. The
// daemon deletes each once its parent's branch merged it, or its root ended
// (ADR 0011).
export function keptChildBranches(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.child && task.worktree && isTerminal(task) && !task.cleanup && !task.child.branchDeleted);
}

// Queues each task waiting on children whose awaited children have all
// reported (Done or Cancelled; a failed one still waits on the operator),
// as continuing work whose next run resumes its session on one report per
// awaited child. Their branches are in its worktree's clone, and an L2
// task's container fetches them in before its next run (ADR 0007).
function wakeParents(state: Lifecycle): void {
  for (const task of Object.values(state.tasks)) {
    if (task.state === 'awaiting-children' && awaitedChildren(state, task).every(isTerminal)) task.state = 'queued';
  }
}

// The task queued again, to wait first for any awaited child still open.
function requeue(state: Lifecycle, task: Task): void {
  task.state = awaitedChildren(state, task).length ? 'awaiting-children' : 'queued';
}

// The run's awaited children are handed over: it started on their reports.
function handReports(state: Lifecycle, run: Run): void {
  for (const id of run.reports ?? []) state.tasks[id]!.child!.delivered = true;
}

// What a run of a parent opens on before what it would open on anyway, once
// some of its awaited children ended: each one's report, and the branches it
// is to merge. An AFK run then carries on unattended, and a run the
// operator took over is theirs to steer.
function reportsOpening(task: Task, children: Task[]): string {
  const reports = children.map((child) => {
    const report = child.child!.report!;
    const { commits } = report;
    const work = commits.length
      ? `- Branch: ${report.branch}, with ${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} (${commits.map(short).join(', ')}). Merge it: \`git merge ${report.branch}\``
      : '- Branch: no commits to merge.';
    return [
      `### ${child.id}: ${child.title}`,
      `- Status: ${report.status}; its run ended ${report.outcome ?? 'without a run'}.`,
      work,
      '',
      report.summary,
      ...(report.notes ? ['', `Notes: ${report.notes}`] : []),
    ].join('\n');
  });
  return [
    '## Factory context',
    `Every awaited child of ${task.id} has reported. Merge each branch that has commits into ${task.worktree?.branch ?? 'your branch'} with a local ` +
      '`git merge`, resolving any conflicts, and carry on from their reports. A merge you can’t resolve fails this run: leave it unresolved, say why, and end.',
    ...reports,
  ].join('\n\n');
}

// What a child's first run opens on (ADR 0009): its skill on the goal (or the
// bare goal), then the factory context its fresh session starts from, since
// it never sees its parent's conversation.
function childOpening(state: Lifecycle, parent: Task, child: Task, spawn: ChildSpawned): string {
  const root = rootOf(state, parent);
  const limits = treeLimits(state, parent);
  const links = root.inputs?.issues.length ? root.inputs.issues : [];
  const facts = [
    `- Root task: ${root.id}, ${root.title}${root.id === parent.id ? '' : `; your parent is ${parent.id}, ${parent.title}`}.`,
    ...(root.goal ? [`- Root goal: ${oneLine(root.goal)}`] : []),
    ...(links.length ? [`- Links: ${links.join(', ')}`] : []),
    spawn.research
      ? `- Your branch: ${child.worktree!.branch}, cut from ${short(spawn.base)} on ${state.repositories[parent.repo]?.baseBranch ?? 'the base branch'}. ` +
        'Commit your findings there, under docs/research/ only.'
      : `- Your branch: ${child.worktree!.branch}, cut from ${short(spawn.base)} on ${parent.worktree!.branch}. Commit your work there; the factory never pushes it.`,
    `- Depth ${child.child!.depth} of ${limits.depth}: ${spawnable(state, child, limits)}.`,
  ];
  const reporting = spawn.research
    ? `You are a research child on the research ticket ${spawn.research.ticket}: your parent doesn’t wait for you. Write your findings as Markdown under ` +
      `docs/research/ and commit them on your branch. Once you report, the factory pushes ${child.worktree!.branch} to GitHub, only if your commits ` +
      'touch nothing but docs/research/**, and closes the ticket, pointing at your branch. Open no PR: the branch is never merged.'
    : child.child!.awaited
      ? 'Your parent waits for your report and merges your branch.'
      : `You are a fire-and-forget child: your parent doesn’t wait for you, and your code never joins ${root.worktree?.branch ?? 'the root’s branch'}. ` +
        'Your output is what you report, and any issues you open.';
  const opening = spawn.skill ? `/factory:${spawn.skill} ${spawn.goal.trim()}` : spawn.goal.trim();
  return [
    opening,
    '## Factory context',
    `This run is child task ${child.id}, delegated by ${parent.id}. ${reporting}`,
    facts.join('\n'),
    'Before you end, report to your parent through the factory’s report_result tool: a summary, a status (such as done, partial or blocked) and notes. ' +
      'Set a one-line status for the operator with report_progress as you go.',
  ].join('\n\n');
}

// The text on one line, cut to fit a row: an agent's status, a root's goal.
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// How many children the new child may spawn, as its tree stands with it in
// it: none at the depth limit, else the fewer of a task's children and the
// tree's descendants left.
function spawnable(state: Lifecycle, child: Task, limits: TreeLimits): string {
  if (child.child!.depth >= limits.depth) return 'you may spawn no children';
  // The child isn't in the tree yet, but counts against it.
  const left = Math.min(limits.children, limits.descendants - subtree(state, rootOf(state, state.tasks[child.parent!]!)).length);
  return left > 0 ? `you may spawn up to ${left} ${left === 1 ? 'child' : 'children'} of your own` : 'your tree has no room for children of your own';
}

// A child's run completed: the child ends Done with its report (ADR 0009),
// and the daemon removes its worktree, and the branch of a fire-and-forget
// child, which can never join the root (ADR 0011).
function finishChild(state: Lifecycle, task: Task, run: Run, { commits = [], result }: Extract<RunEvent, { type: 'runCompleted' }>): void {
  // A child the operator took over and finished in conversation, never handing it back, reports so.
  const fallback = run.mode === 'HITL' ? 'The operator took this child over and finished it in conversation.' : 'The child ended without a summary.';
  closeReport(task, { summary: result?.trim() || fallback, status: 'completed', commits, outcome: run.outcome });
  noteParent(state, task);
  task.progress = null;
  task.state = 'done';
  // A research child's findings go to GitHub first (ADR 0007), and its
  // ticket closes; with none committed, only the ticket does.
  const { research } = task.child!;
  if (research) research.step = commits.length ? 'push' : 'close';
  else if (task.worktree) task.cleanup = { problem: null, keepBranch: task.child!.awaited };
}

// A research child's publishing stopped on `problem`: a github-write
// request asks the operator, and the child stays Done.
function failResearch(state: Lifecycle, task: Task, request: AttentionRequest | undefined, problem: string, at: number): void {
  task.child!.research!.problem = problem;
  if (!request) addRequest(state, task, lastRun(state, task), 'github-write', false, problem, at);
}

// A factory note about the fire-and-forget child to its HITL parent's
// conversation (ADR 0009), by default its report once it ended. The parent
// holds it until it is delivered: on the operator's turn, which the daemon
// waits for, or in the parent's next run's opening, whatever ended its
// run meanwhile. An AFK parent reads its report through list_children,
// and an ended one hears nothing.
function noteParent(state: Lifecycle, child: Task, note = childNote(child)): void {
  const parent = state.tasks[child.parent!];
  if (!parent || parent.mode !== 'HITL' || isTerminal(parent) || child.child!.awaited) return;
  (parent.factoryNotes ??= []).push(note);
}

// A factory note saying what `paragraphs` say, in the conversation's Markdown.
function factoryNote(...paragraphs: string[]): string {
  return ['## Factory note', ...paragraphs].join('\n\n');
}

// What the factory note of a child's report says.
function childNote(child: Task): string {
  const report = child.child!.report!;
  const research = child.child!.research;
  return factoryNote(
    `Your fire-and-forget child ${child.id} (${child.title}) has reported: ${report.status}; its run ended ${report.outcome ?? 'without a run'}.`,
    ...(research && report.status !== 'cancelled'
      ? [
          report.commits.length
            ? `The factory pushes ${report.branch} next, if its commits touch nothing but docs/research/**, then closes the research ticket ${research.ticket}.`
            : `It committed no findings: the factory closes the research ticket ${research.ticket} next.`,
        ]
      : []),
    report.summary,
    ...(report.notes ? [`Notes: ${report.notes}`] : []),
  );
}

// Settles the ended child's report: what its agent reported through
// `report_result`, over the factory's `fallback` summary and status, with the
// facts the factory holds. A `forced` end (a cancel) has its own status.
function closeReport(
  task: Task,
  fallback: { summary: string; status: string; commits: string[]; outcome: RunOutcome | null },
  { forced = false } = {},
): void {
  const child = task.child!;
  const reported = child.agentReport;
  child.report = {
    summary: reported?.summary ?? fallback.summary,
    status: forced ? fallback.status : (reported?.status ?? fallback.status),
    notes: reported?.notes ?? '',
    branch: task.worktree?.branch ?? '',
    commits: [...fallback.commits],
    outcome: fallback.outcome,
  };
  child.agentReport = null;
}

// Cancel means everything stops: the task and its whole subtree end
// Cancelled. A cancelled child reports `cancelled`. `keepBranch` keeps the
// task's own branch, as Keep branch does; a descendant's goes with the tree.
function cancelSubtree(state: Lifecycle, task: Task, keepBranch: boolean, at: number): void {
  for (const cancelled of subtree(state, task)) {
    if (isTerminal(cancelled)) continue;
    const live = liveRun(state, cancelled);
    if (live) endRun(live, 'cancelled', at);
    for (const open of Object.values(state.requests)) if (open.taskId === cancelled.id && open.status === 'open') open.status = 'closed';
    cancelled.handoff = null;
    cancelled.loop = null;
    cancelled.progress = null;
    // A root's draft PR is closed, and the task branch the factory pushed deleted.
    const pushed = pushedBranch(cancelled);
    const remote = pushed ? { branch: pushed, prToClose: cancelled.pr?.number ?? null } : null;
    cancelled.publishing = null;
    cancelled.state = 'cancelled';
    if (cancelled.child) {
      closeReport(cancelled, { summary: 'Cancelled before it finished.', status: 'cancelled', commits: [], outcome: 'cancelled' }, { forced: true });
      noteParent(state, cancelled);
    }
    // The daemon archives its transcripts, then removes its worktree and
    // branch, unless the operator kept it.
    if (cancelled.worktree) cancelled.cleanup = { problem: null, keepBranch: cancelled === task && keepBranch, remote };
  }
}

// Allow once, for the task or always, or deny with a note that isn't blank.
function validPermissionAnswer(answer: PermissionAnswer | undefined): boolean {
  if (!answer) return false;
  return 'deny' in answer ? typeof answer.deny === 'string' && answer.deny.trim() !== '' : answer.allow === 'once' || allowsByRules(answer);
}

// Why a permission answer can't stand, or null. `named` says the call it
// answers is named, so only an allow or a deny with a note answers it.
function permissionRefusal(answer: PermissionAnswer | undefined, named: boolean): string | null {
  if (named && !validPermissionAnswer(answer)) return 'Allow it once, for this task or always, or deny it with a note for the agent.';
  if (!allowsByRules(answer)) return null;
  const { allow, rules } = answer;
  return rules !== undefined && !(Array.isArray(rules) && rules.length > 0 && rules.every(isRule))
    ? `${BY_RULES[allow].answer} needs at least one rule, each such as \`Bash(sed -i *)\`.`
    : null;
}

// Whether the answer allows by rules: for the rest of the task, or always.
export function allowsByRules(answer: PermissionAnswer | undefined): answer is RulesAnswer {
  return !!answer && 'allow' in answer && (answer.allow === 'task' || answer.allow === 'always');
}

// Each answer by rules: what the operator chose, and how long its rules hold.
const BY_RULES = {
  task: { answer: 'Allow for this task', holds: 'for the rest of this task' },
  always: { answer: 'Allow always', holds: 'from now on, in every task,' },
} as const;

// The open permission requests whose calls the rules, with their task's own,
// now cover: those an Allow always whose rules these are lets through.
export function coveredRequests(state: Lifecycle, rules: readonly string[]): AttentionRequest[] {
  return Object.values(state.requests).filter((request) => {
    if (request.status !== 'open' || !request.permission || !request.taskId) return false;
    const { id, summary, rule } = request.permission;
    const taskRules = state.tasks[request.taskId]!.allowRules ?? [];
    return uncovered([...rules, ...taskRules], { id, summary, ...callWithRule(rule) }).length === 0;
  });
}

// Which of the operator's answers lets the call through, if any: the task's
// rules, when they cover every part the factory's and operator's rules left
// uncovered, or the call's own rule allowed once for the run.
function grantFor(task: Task, run: Run, asked: PermissionAsked): 'task' | 'once' | null {
  const rule = ruleFor(asked.call);
  // Rules stored before patterns were each a whole call's own.
  if (task.allowRules?.includes(rule) || leftUncovered(task, asked).length === 0) return 'task';
  return run.allowOnce?.includes(rule) ? 'once' : null;
}

// A run's call the factory's and operator's rules left parts of uncovered.
type PermissionAsked = Extract<RunEvent, { type: 'permissionAsked' }>;

// The parts of the call no rule covers, the task's included.
function leftUncovered(task: Task, { call, parts = [call] }: PermissionAsked): ToolCall[] {
  return parts.flatMap((part) => uncovered(task.allowRules ?? [], part));
}

// What a permission request proposes for the parts left uncovered: a pattern
// for each, once.
function proposals(parts: ToolCall[]): ProposedRule[] {
  // Each pattern, with the summary of the first part it was proposed for.
  const proposed = new Map<string, string>();
  for (const part of parts) {
    const rule = patternFor(part);
    if (!proposed.has(rule)) proposed.set(rule, part.summary);
  }
  return [...proposed].map(([rule, summary]) => ({ part: summary, rule }));
}

// The conversation waits while the handoff sheet is open over it.
function sheetOpen(task: Task): string {
  return `The handoff sheet is open on ${task.id}: back out of it (esc) to keep talking.`;
}

// The AFK stage a handoff starts: the first from the task's own stage on.
// Remaining HITL stages are skipped, and so is a stage that requires L2,
// which a handoff doesn't reach yet. Null when the task has none ahead.
export function handoffStage(task: Task): Stage | null {
  const stages = task.preset?.stages ?? [];
  const from = Math.max(stages.findIndex(({ id }) => id === task.stage), 0);
  return stages.slice(from).find((stage) => stage.mode === 'AFK' && stage.requires !== 'L2') ?? null;
}

// The handoff's files of `committed`, as the handoff commit took them.
function commitArtifacts(state: Lifecycle, task: Task, committed: string[]): void {
  for (const artifact of artifactsOf(state, task)) {
    if (artifact.kind === 'file' && committed.includes(artifact.path)) artifact.committed = true;
  }
}

// Why the handoff can't confirm the spec candidates `specs`, or null: each
// must be one the sheet offers, and a spec task works one spec.
function specsRefusal(sheet: HandoffSheet, specs: unknown): string | null {
  if (!Array.isArray(specs) || !specs.every((spec) => typeof spec === 'string')) return 'The specs confirmed are a list of issue refs.';
  const offered = sheet.ticketSets?.candidates.map(({ spec }) => spec) ?? [];
  const unknown = specs.find((spec) => !offered.includes(spec));
  if (unknown) return `${unknown} isn’t a spec candidate of this handoff${offered.length ? ` (${offered.join(', ')})` : ''}.`;
  if (new Set(specs).size > 1) return `A spec task works one spec: keep one of ${[...new Set(specs)].join(', ')} selected.`;
  return null;
}

// A new handoff sheet, pre-filled from the AFK stage it hands off to. It
// hands off at L1 (a ticket task at its spec task's level) unless the
// operator changes it on the sheet.
function newHandoffSheet(state: Lifecycle, task: Task, readiness: Readiness): HandoffSheet {
  const stage = handoffStage(task);
  const share = task.context ? task.context.used / task.context.window : null;
  return {
    brief: null,
    asked: false,
    stage: stage?.id ?? null,
    continueAs: share !== null && share > FRESH_AT ? 'fresh' : 'resume',
    // A ticket task's handoff starts at the level its spec task was handed off at.
    autonomy: (task.kind === 'ticket' && task.specTask && state.tasks[task.specTask]?.autonomy) || 'L1',
    mergePolicy: 'operator',
    tier: task.operatorTier ?? task.inputs?.tier ?? stage?.model ?? DEFAULT_TIER,
    maxTurns: task.maxTurns ?? stage?.max_turns ?? DEFAULT_MAX_TURNS,
    contextShare: share,
    readiness,
  };
}

// The brief with its text trimmed and its empty items dropped: it comes from
// the agent's tool call, or the operator's edits.
function tidyBrief(brief: Brief): Brief {
  const items = (list: unknown) => (Array.isArray(list) ? list.map((item) => String(item).trim()).filter(Boolean) : []);
  return {
    goal: String(brief.goal ?? '').trim(),
    decided: items(brief.decided),
    doneWhen: items(brief.doneWhen),
    outOfScope: items(brief.outOfScope),
    links: items(brief.links),
  };
}

// The brief as the AFK run reads it, its empty sections left out.
export function briefText({ goal, decided, doneWhen, outOfScope, links }: Brief): string {
  const sections: [string, string[]][] = [
    ['Decided', decided],
    ['Done when', doneWhen],
    ['Out of scope', outOfScope],
    ['Links', links],
  ];
  const listed = sections.filter(([, items]) => items.length).map(([heading, items]) => `## ${heading}\n\n${items.map((item) => `- ${item}`).join('\n')}`);
  return ['# Handoff brief', goal, ...listed].join('\n\n');
}

// An AFK run is steered only through attention requests and takeover.
function takesNoChat(task: Task): string {
  return `${task.id} is AFK, so it takes no chat. Take it over to talk to it.`;
}

function tierRefusal(tier: string): string {
  return `${tier} is not a model tier (${TIERS.slice(0, -1).join(', ')} or ${TIERS.at(-1)}).`;
}

function priorityRefusal(priority: Priority): string | null {
  return PRIORITIES.includes(priority) ? null : `${priority} is not a priority (${PRIORITIES.join(' or ')}).`;
}

// Why no new run can start in the task's repository, or null (ADR 0010).
function cantStartRuns(state: Lifecycle, task: Task): string | null {
  return state.repositories[task.repo]?.missing ? `${task.repo} is missing, so its runs can’t start.` : null;
}

function nextId(state: Lifecycle, kind: Exclude<keyof Lifecycle['counters'], 'queue'>): string {
  const prefix = { task: 'T', run: 'R', request: 'A', artifact: 'X' }[kind];
  return prefix + ++state.counters[kind];
}

// A task's first run starts on its goal; later ones resume its session and
// wait for the operator, unless they start a stage. A later AFK run carries
// on, or opens on what the task saved for it.
function startRun(
  state: Lifecycle,
  task: Task,
  at: number,
  {
    opening = task.runIds.length === 0 ? task.goal : (task.resumeWith ?? (task.mode === 'AFK' ? AFK_RESUME : null)),
    resumesSession = task.runIds.length > 0 && !task.newSession,
  } = {},
): void {
  // A task back from waiting on children opens on their reports first: they
  // count as handed over once the run started, so a run that never did hands
  // them to the next.
  const reported = awaitedChildren(state, task).filter(isTerminal);
  if (reported.length) opening = [reportsOpening(task, reported), opening].filter(Boolean).join('\n\n');
  // So do the factory notes a parked conversation held.
  if (task.factoryNotes?.length) {
    opening = [...task.factoryNotes, opening].filter(Boolean).join('\n\n');
    task.factoryNotes = [];
  }
  task.resumeWith = null;
  task.newSession = false;
  task.pushed = false;
  const tier = nextTier(task);
  const allowOnce = task.allowOnce ?? [];
  task.allowOnce = [];
  task.sessionId ??= `S${task.id.slice(1)}`;
  const run: Run = {
    id: nextId(state, 'run'),
    taskId: task.id,
    mode: task.mode,
    autonomy: task.mode === 'AFK' ? clampAutonomy(task.autonomy!, stageOf(task, task.stage)) : null,
    status: 'active',
    outcome: null,
    interruption: null,
    resumesSession,
    sessionId: task.sessionId,
    turn: opening ? 'agent' : 'operator',
    queued: [],
    question: null,
    stage: task.stage ?? null,
    ticket: task.kind === 'ticket' ? (task.ticket ?? null) : null,
    opening,
    reports: reported.map((child) => child.id),
    proposal: null,
    tier,
    // Routed by `reduce`, once it knows every run the action starts.
    model: '',
    maxTurns: task.mode === 'AFK' ? (task.maxTurns ?? stageOf(task, task.stage)?.max_turns ?? DEFAULT_MAX_TURNS) : null,
    cli: null,
    parksAt: null,
    allowOnce,
    // Tasks stored before skill sets were frozen have none.
    skillSet: task.skillSet ?? null,
    startedAt: at,
    endedAt: null,
  };
  state.runs[run.id] = run;
  task.runIds.push(run.id);
  task.state = 'running';
}

function endRun(run: Run, outcome: RunOutcome, at: number): void {
  run.status = 'ended';
  run.outcome = outcome;
  run.parksAt = null;
  run.endedAt = at;
  run.countedMessages = null;
  run.waitingForWindow = null;
}

export function isMetering(action: { type: string }): action is Extract<RunEvent, { type: 'usageSampled' | 'usageTotaled' }> {
  return action.type === 'usageSampled' || action.type === 'usageTotaled';
}

const MINUTE_MS = 60_000;

// Adds `change` to the run's record, and to its sample for the minute `at` is in.
function meter(state: Lifecycle, run: Run, change: ModelUsage, at: number): void {
  run.usage = merged(run.usage ?? {}, change);
  const minute = at - (at % MINUTE_MS);
  const id = `${run.id}@${minute}`;
  const sample = state.samples[id] ?? { id, runId: run.id, minute, models: {} };
  state.samples[id] = { ...sample, models: merged(sample.models, change) };
}

// What the runs of the run's session other than it recorded.
function othersInSession(state: Lifecycle, run: Run): ModelUsage {
  const sessionOf = (other: Run) => other.sessionId ?? state.tasks[other.taskId]!.sessionId;
  const session = sessionOf(run);
  return merged(...Object.values(state.runs).flatMap((other) => (other !== run && sessionOf(other) === session ? [other.usage ?? {}] : [])));
}

// Ends a run that waited on the operator too long. Reopening the task, or
// answering the request its run was suspended on, starts a new run that
// resumes the session.
function park(state: Lifecycle, task: Task, run: Run, at: number): void {
  endRun(run, 'parked', at);
  const request = openRequest(state, task);
  if (request?.holdsRun) request.holdsRun = false;
  else task.state = 'queued';
}

// Ends every live run (ADR 0002, ADR 0003): an active AFK run is
// interrupted, losing only its in-flight turn, and its task queues again to
// resume on the recovery note. Suspended and HITL runs park, as they would
// once their deadline passed. A task whose run was active at the unclean
// start before this one too isn't requeued again: its run fails.
// After an unclean start, what it did goes in the one Factory recovered
// report: the open one, if the operator hasn't dismissed it yet, with the
// leftovers it found.
function reconcile(state: Lifecycle, interruption: Interruption, replayed: ReplayedIntent[], found: Found | undefined, at: number): void {
  const recovery: Recovery = { requeued: [], parked: [], failed: [], replayed, ...(found && (found.containers.length || found.worktrees.length) && { found }) };
  // A handoff sheet still open was never confirmed: a confirmed one's
  // intent has just been replayed. It is saved as a draft the next opens from.
  for (const task of Object.values(state.tasks)) {
    if (!task.handoff) continue;
    const { brief, continueAs, autonomy, mergePolicy, tier, maxTurns } = task.handoff;
    task.handoffDraft = structuredClone({ brief, continueAs, autonomy, mergePolicy, tier, maxTurns });
    task.handoff = null;
  }
  // An unclean start that finds a task with no active run ends its crash loop.
  if (interruption === 'unclean') {
    for (const task of Object.values(state.tasks)) {
      const run = liveRun(state, task);
      if (task.uncleanStarts && !(run?.status === 'active' && run.mode === 'AFK')) task.uncleanStarts = 0;
    }
  }
  for (const run of Object.values(state.runs)) {
    if (run.status === 'ended') continue;
    const task = state.tasks[run.taskId]!;
    const ref = { taskId: task.id, runId: run.id };
    if (run.status === 'active' && run.mode === 'AFK') {
      if (interruption === 'unclean') task.uncleanStarts = (task.uncleanStarts ?? 0) + 1;
      if ((task.uncleanStarts ?? 0) >= CRASH_LOOP_STARTS) {
        endRun(run, 'failed', at);
        raise(state, task, run, 'failure', false, `${run.id} was active when the factory stopped uncleanly twice in a row, so the factory didn’t requeue it again: it may be what crashes the factory.`, at);
        recovery.failed.push(ref);
        continue;
      }
      endRun(run, 'interrupted', at);
      run.interruption = interruption;
      task.resumeWith = RECOVERY_NOTE;
      requeue(state, task);
      recovery.requeued.push(ref);
    } else {
      park(state, task, run, at);
      recovery.parked.push(ref);
    }
  }
  // A task the daemon before left on the retired Ralph loop's stage asks
  // the operator to cancel or relaunch it (ADR 0013): nothing is migrated.
  for (const task of Object.values(state.tasks)) {
    if (!isTerminal(task) && task.state !== 'draft' && task.state !== 'in-review' && atRetiredLoop(task)) blockRetiredLoop(state, task, at);
  }
  const { found: anyFound, ...runsAndIntents } = recovery;
  if (interruption === 'unclean' && (anyFound || Object.values(runsAndIntents).some((listed) => listed.length))) reportRecovery(state, recovery, at);
}

// Adds what recovery did to the open Factory recovered report, or raises one.
function reportRecovery(state: Lifecycle, recovery: Recovery, at: number): void {
  const open = recoveryReport(state);
  const before = open?.recovery ?? { requeued: [], parked: [], failed: [] };
  const merged: Recovery = {
    requeued: [...before.requeued, ...recovery.requeued],
    parked: [...before.parked, ...recovery.parked],
    failed: [...before.failed, ...recovery.failed],
    replayed: [...(before.replayed ?? []), ...(recovery.replayed ?? [])],
  };
  // What an earlier start found and this one found again is listed once.
  if (before.found || recovery.found) {
    const union = (pick: (found: Found) => string[]) => [...new Set([...(before.found ? pick(before.found) : []), ...(recovery.found ? pick(recovery.found) : [])])];
    merged.found = { containers: union((found) => found.containers), worktrees: union((found) => found.worktrees) };
  }
  const request: AttentionRequest = open ?? {
    id: nextId(state, 'request'),
    repo: null,
    taskId: null,
    runId: null,
    kind: 'recovery-report',
    status: 'open',
    holdsRun: false,
    reason: null,
    raisedAt: at,
  };
  request.recovery = merged;
  request.reason = recoveryReason(merged);
  state.requests[request.id] = request;
}

function recoveryReason({ requeued, parked, failed, replayed = [], found }: Recovery): string {
  const runs = (refs: RunRef[]) => refs.map(({ taskId, runId }) => `${taskId} (${runId})`).join(', ');
  const intents = replayed.map(({ taskId, verb, outcome }) => `${taskId}’s ${verb}${outcome === 'rolled back' ? ' (rolled back)' : ''}`).join(', ');
  return [
    'The factory restarted after it stopped uncleanly.',
    ...(replayed.length ? [`Replayed ${intents}.`] : []),
    ...(requeued.length ? [`Requeued ${runs(requeued)}.`] : []),
    ...(parked.length ? [`Parked ${runs(parked)}.`] : []),
    ...(failed.length ? [`Failed ${runs(failed)}: active at two unclean starts in a row.`] : []),
    ...(found ? [`Found what no live task has: ${foundText(found)}. It deleted none of them: :gc lists them to delete.`] : []),
  ].join(' ');
}

// The leftovers recovery found, as its report lists them. The factory stops
// each container, as it does every container whose task has no live run
// (ADR 0011), but it may not have yet when the report is written.
function foundText({ containers, worktrees }: Found): string {
  const items = [...containers.map((taskId) => `${taskId}’s container`), ...worktrees.map((path) => `the worktree at ${path}`)];
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]!;
}

// Whether a conflicting PR queues an update run on the root: an AFK ticket
// task's, unless one was queued since its PR was last found mergeable. A
// HITL one's work stays the operator's (ADR 0004).
// So does a root the factory merges at its gate (ADR 0014), which can't
// merge while it conflicts.
export function updatesOnConflict(task: Task): boolean {
  return (task.kind === 'ticket' || factoryMerges(task)) && task.mode === 'AFK' && !task.conflicted;
}

// What the update run on a ticket task's conflicting PR opens on.
function updateOpening(state: Lifecycle, task: Task): string {
  const base = state.repositories[task.repo]!.baseBranch;
  return (
    `GitHub finds PR #${task.pr!.number} of ${task.id} conflicting with ${base}, which moved on since its branch was cut. ` +
    `Unattended, merge \`origin/${base}\` into the task branch ${task.worktree!.branch} (merge, never rebase: the factory fetched it for you), ` +
    'resolve the conflicts, check the merged work still builds and passes its tests, and commit the merge. ' +
    `The task goes back to ${factoryMerges(task) ? 'its merge gate' : 'the operator’s review'} once your run ends. If you can’t resolve them, leave the merge unfinished and end your run: ` +
    'the factory fails it and asks the operator.'
  );
}

// What the run that resumes a root on the operator's review comments opens on.
function changesOpening(task: Task, comments: string): string {
  const asked = `The operator reviewed ${task.id} and requested changes:\n\n${comments.trim()}`;
  // A HITL run's operator is there to say more.
  if (task.mode === 'HITL') return asked;
  return `${asked}\n\nMake them, unattended, and commit them to the task branch: the task goes back to the operator’s review once your run ends.`;
}

// What a question's answers are, for the run that resumes after its asker parked.
function openingWithAnswers(question: Question, answers: Answers): string {
  const lines = question.questions.map(({ question }) => `${question} ${answers[question]!.trim()}`);
  return `While this conversation was parked, the operator answered your question:\n\n${lines.join('\n')}\n\n${AFK_RESUME}`;
}

// The run waits on an attention request, holding no slot, until it parks.
function suspend(run: Run, at: number): void {
  run.status = 'suspended';
  run.parksAt = at + REQUEST_PARK_MS;
}

// What the operator answered a permission request with, for the run that
// resumes after its asker parked.
function openingWithVerdict(permission: Permission, answer: PermissionAnswer): string {
  const { tool, summary } = permission;
  const verdict =
    'deny' in answer
      ? `denied ${tool}: ${summary}. Their note: ${answer.deny.trim()}`
      : answer.allow === 'once'
        ? `allowed ${tool} once: ${summary}. Make that call again now.`
        : `allowed ${tool}: ${summary}, and ${BY_RULES[answer.allow].holds} the calls these rules cover: ${allowedRules(permission, answer).join(', ')}.`;
  return `While this conversation was parked, the operator ${verdict}

${AFK_RESUME}`;
}

// The rules an answer by rules allows: the operator's, or else the ones the
// request proposed.
export function allowedRules(permission: Permission, answer: RulesAnswer): string[] {
  return answer.rules?.map((rule) => rule.trim()) ?? permission.proposed?.map(({ rule }) => rule) ?? [permission.rule];
}

// Answers the task's HITL run's card, if `answer` decides one: the executor
// hands its call the verdict. Allow for this task adds its rules to the
// task's; Allow always's are the operator's file's, which the daemon added them to.
function answerCard(state: Lifecycle, task: Task, answer: PermissionAnswer | undefined): boolean {
  const card = openCard(state, task);
  if (!card) return false;
  if (allowsByRules(answer) && answer.allow === 'task') addTaskRules(task, card, answer);
  liveRun(state, task)!.permission = null;
  return true;
}

// Allow for this task: the answer's rules join the task's, each once.
function addTaskRules(task: Task, permission: Permission, answer: RulesAnswer): void {
  const rules = (task.allowRules ??= []);
  for (const rule of allowedRules(permission, answer)) if (!rules.includes(rule)) rules.push(rule);
}

function raise(
  state: Lifecycle,
  task: Task,
  // The run it is about, if the task has had one.
  run: Run | undefined,
  kind: AttentionKind,
  holdsRun: boolean,
  reason: string | null,
  at: number,
  extra: RequestExtra = {},
): void {
  addRequest(state, task, run, kind, holdsRun, reason, at, extra);
  task.state = 'waiting';
}

// Why a run whose weekly usage window is spent failed: what failed it, and when the window resets.
function weeklyLimitReason(resetsAt: number, failure: string): string {
  return `${failure.replace(/\.?\s*$/, '.')} The weekly usage limit is spent: it resets ${resetTime(resetsAt)}.`;
}

// Logs on the run the hosts its container's egress proxy denied it (ADR 0007).
function logDenials(run: Run, hosts: string[] | undefined): void {
  if (hosts?.length) run.deniedHosts = [...hosts];
}

// A failure's reason, saying which hosts its run was denied, if any.
function withDenials(reason: string, hosts: string[] | undefined): string {
  if (!hosts?.length) return reason;
  const named = hosts.length === 1 ? hosts[0] : `${hosts.slice(0, -1).join(', ')} and ${hosts.at(-1)}`;
  return `${reason} Its container’s egress proxy denied ${named}.`;
}

// Whether the machine is kept from idle sleep while an AFK run is active:
// on unless the operator turned it off (ADR 0003).
export function keepsAwake(state: Lifecycle): boolean {
  return state.keepAwake ?? true;
}

// A failure the daemon saw shortly after a wake says so, so the operator can
// tell sleep problems from real ones (ADR 0003).
function withWakeHint(reason: string, woke: boolean | undefined): string {
  return woke ? `${reason} It failed shortly after the machine woke from sleep.` : reason;
}

// A request about the task that leaves its state as it is, such as one a
// cancelled task's cascade raises.
function addRequest(
  state: Lifecycle,
  task: Task,
  run: Run | undefined,
  kind: AttentionKind,
  holdsRun: boolean,
  reason: string | null,
  at: number,
  { question = null, permission = null, deniedHosts = null, skipped = null }: RequestExtra = {},
): void {
  const request: AttentionRequest = {
    id: nextId(state, 'request'),
    repo: task.repo,
    taskId: task.id,
    runId: run?.id ?? null,
    kind,
    status: 'open',
    holdsRun,
    reason,
    question,
    permission,
    ...(deniedHosts?.length ? { deniedHosts: [...deniedHosts] } : {}),
    ...(skipped?.length ? { skipped: [...skipped] } : {}),
    raisedAt: at,
  };
  state.requests[request.id] = request;
}

// What a request holds besides its kind and reason.
type RequestExtra = { question?: Question | null; permission?: Permission | null; deniedHosts?: string[] | null; skipped?: string[] | null };

function addArtifact(state: Lifecycle, artifact: DistributiveOmit<Artifact, 'id'>): void {
  const id = nextId(state, 'artifact');
  state.artifacts[id] = { id, ...artifact } as Artifact;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function closeRepoRequest(state: Lifecycle, repo: string): void {
  const request = openRepoRequest(state, repo);
  if (request) request.status = 'closed';
}

// The scheduler (ADR 0008): starts queued AFK tasks in turn while the
// admission check lets them. Urgent tasks go first, then work that continues
// something in flight (a task that has run before), then first in, first out.
function schedule(state: Lifecycle, at: number): void {
  const urgent = (task: Task) => Number(task.priority === 'urgent');
  const continuing = (task: Task) => Number(task.runIds.length > 0);
  const queued = Object.values(state.tasks).filter((task) => task.state === 'queued' && task.mode === 'AFK');
  queued.sort((a, b) => urgent(b) - urgent(a) || continuing(b) - continuing(a) || (a.queuePlace ?? 0) - (b.queuePlace ?? 0));
  for (const task of queued) {
    if (!admits(state)) return;
    if (cantStartRuns(state, task)) continue;
    startRun(state, task, at);
  }
}

// The slots taken: by active AFK runs.
export function heldSlots(state: Lifecycle): number {
  return activeAfkRuns(state);
}

// The one admission check: whether another AFK run may start now. v1 checks
// only the slot cap; a usage-window gate would join it here (ADR 0008).
function admits(state: Lifecycle): boolean {
  return heldSlots(state) < state.slotCap;
}

function apply(state: Lifecycle, action: LifecycleAction, at: number): void {
  const task = taskOf(state, action)!;
  const run = task && liveRun(state, task);
  const request = task && openRequest(state, task);
  switch (action.type) {
    case 'createTask': {
      const created: Task = {
        id: nextId(state, 'task'),
        title: action.title.trim(),
        repo: action.repo,
        mode: action.mode,
        autonomy: action.mode === 'AFK' ? (action.autonomy ?? 'L1') : null,
        groups: [...(action.groups ?? [])],
        priority: action.priority ?? 'normal',
        goal: null,
        operatorTier: null,
        worktree: null,
        skillSet: null,
        sessionId: null,
        runIds: [],
        state: action.submit ? 'queued' : 'draft',
        createdAt: at,
      };
      state.tasks[created.id] = created;
      break;
    }
    case 'taskLaunched': {
      // The task takes its start stage's mode: a HITL stage opens its
      // conversation at once, and an AFK one queues for a slot with its
      // handoff fields.
      const start = action.preset.stages.find(({ id }) => id === action.stage)!;
      const { mode } = start;
      const ticket = action.ticket ?? null;
      const specSet = action.specSet ?? null;
      const launched: Task = {
        id: nextId(state, 'task'),
        title: action.title,
        // Frozen for a task starting AFK (ADR 0014); one starting HITL picks it at its handoff.
        ...(mode === 'AFK' && { mergePolicy: policyOf(action) }),
        ...(ticket && { kind: 'ticket' as const, ticket }),
        // A spec task reads its tickets from GitHub first (ADR 0013).
        ...(specSet && {
          kind: 'spec' as const,
          ticketSet: { spec: specSet.spec, tickets: [...specSet.tickets], reading: true, issues: [], toLaunch: [], launched: {}, problem: null },
        }),
        launchSummary: action.launchSummary?.trim() || null,
        repo: action.repo,
        mode,
        autonomy: mode === 'AFK' ? action.autonomy : null,
        priority: action.priority,
        maxTurns: mode === 'AFK' ? action.maxTurns : null,
        groups: [...new Set(action.groups.map((group) => group.trim()).filter(Boolean))],
        goal: ticket ? ticketOpening(start, ticket, action.prompt) : action.opening,
        operatorTier: action.operatorTier,
        worktree: { ...action.worktree },
        skillSet: action.skillSet,
        preset: structuredClone(action.preset),
        stage: action.stage,
        inputs: {
          prompt: action.prompt,
          issues: [...action.issues],
          issueKinds: artifactKindsIn(action.preset.stages.find(({ id }) => id === action.stage)!),
        },
        sessionId: action.sessionId,
        runIds: [],
        // A spec task runs no agent, so it never queues for a slot: it is
        // at work launching its ticket tasks.
        state: specSet ? 'running' : 'queued',
        createdAt: at,
        quick: action.quick ? { questions: 0, done: false } : null,
      };
      state.tasks[launched.id] = launched;
      // A work loop starts from its map's frontier.
      if (!enterLoop(state, launched, stageOf(launched, action.stage)!) && mode === 'HITL') startRun(state, launched, at);
      break;
    }
    case 'submit':
      task.state = 'queued';
      break;
    case 'open': {
      if (!picksFromFrontier(task)) {
        startRun(state, task, at);
        break;
      }
      // Each ticket of the map is worked in a fresh session (wayfinder
      // resolves one ticket per session).
      const { frontier, session } = task.loop!;
      const ticket = frontier!.find(({ ref }) => ref === action.ticket) ?? frontier![0]!;
      task.loop = workLoop({ ticket: ticket.ref });
      if (session) {
        task.sessionId = session;
        task.newSession = true;
        task.context = null;
      }
      startRun(state, task, at, { opening: workOpening(state, task, ticket) });
      break;
    }
    case 'sendMessage':
      // Talking on sets the agent's proposal aside.
      run!.proposal = null;
      // The executor delivers it at once on the operator's turn; mid-turn it waits.
      if (run!.turn === 'agent') run!.queued.push(action.text);
      else run!.turn = 'agent';
      break;
    case 'researchPushed':
      task.child!.research!.step = 'close';
      break;
    case 'researchPushRefused': {
      const { branch } = task.worktree!;
      const { ticket } = task.child!.research!;
      const paths = action.paths.join(', ');
      failResearch(state, task, request, `${branch} changes ${paths}, outside docs/research/, so the factory won’t push it ` +
        `or close ${ticket}. Rewrite the branch to touch docs/research/** alone, then answer to try again.`, at);
      // The conversation that spawned it was told the push comes next: it
      // hears of the first refusal, never again of a retry refused the same.
      const research = task.child!.research!;
      if (!research.refusalNoted) {
        research.refusalNoted = true;
        const why = `The factory didn’t push ${branch} of your child ${task.id}: it changes ${paths}, outside docs/research/.`;
        noteParent(state, task, factoryNote(`${why} ${ticket} stays open until the operator answers the attention request this raised.`));
      }
      break;
    }
    case 'researchFailed': {
      const { research } = task.child!;
      const what = action.step === 'push' ? `push ${task.worktree!.branch}` : `close ${research!.ticket}`;
      failResearch(state, task, request, `The factory couldn’t ${what} on GitHub as its App: ${action.reason} Fix it, then answer to try again.`, at);
      break;
    }
    case 'researchClosed':
      // Its findings are on GitHub: the worktree and local branch go.
      task.child!.research!.step = null;
      if (request) request.status = 'closed';
      task.cleanup = { problem: null, keepBranch: false };
      break;
    case 'notesDelivered':
      // The executor sends them as the agent's next message.
      run!.turn = 'agent';
      task.factoryNotes = [];
      break;
    case 'interrupt':
      // The executor cuts the turn, and reports its end like any other.
      break;
    case 'answerQuestion':
      // The executor hands the answers to the waiting turn.
      if (task.quick) task.quick.questions += run!.question!.questions.length;
      run!.question = null;
      break;
    case 'handedOff': {
      const sheet = task.handoff!;
      if (run) endRun(run, 'handed off', at);
      task.handoff = null;
      task.handoffDraft = null;
      task.mode = 'AFK';
      task.autonomy = action.autonomy;
      task.mergePolicy = policyOf(action);
      // What the operator changed on the sheet holds for every later stage too.
      if (action.tier !== sheet.tier) task.operatorTier = action.tier;
      if (action.maxTurns !== sheet.maxTurns) task.maxTurns = action.maxTurns;
      // The brief is the task's goal of record, and the AFK run's first
      // message, after its stage's skill: the brief stands in for args an
      // early handoff skipped the stages for.
      task.goal = briefText(tidyBrief(action.brief));
      task.brief = task.goal;
      const to = stageOf(task, sheet.stage);
      // The spec candidate confirmed makes it a spec task over its tickets
      // (ADR 0013): it runs no agent and holds no slot, and reads them
      // from GitHub first.
      const confirmed = sheet.ticketSets?.candidates.find(({ spec }) => action.specs?.includes(spec));
      if (to && confirmed) {
        task.stage = to.id;
        task.kind = 'spec';
        task.ticketSet = { spec: confirmed.spec, tickets: confirmed.tickets.map(({ ref }) => ref), reading: true, issues: [], toLaunch: [], launched: {}, problem: null };
        task.loop = null;
        task.resumeWith = null;
        commitArtifacts(state, task, action.committed);
        task.state = 'running';
        break;
      }
      if (to) task.stage = to.id;
      task.loop = null;
      const opening = to && fillOpening(to, (variable) => argValue(state, task, variable) ?? '');
      task.resumeWith = opening && 'opening' in opening && opening.opening ? `${stageOpening(task, to, opening.opening)}\n\n${task.goal}` : task.goal;
      if (action.continueAs === 'fresh') {
        task.sessionId = action.sessionId;
        task.newSession = true;
        task.context = null;
      }
      commitArtifacts(state, task, action.committed);
      // Queued as work continuing something in flight, for the scheduler.
      task.state = 'queued';
      // Handed off to the retired Ralph loop's stage, it asks the operator instead.
      if (atRetiredLoop(task)) blockRetiredLoop(state, task, at);
      break;
    }
    case 'closeHandoff':
      task.handoff = null;
      break;
    case 'expandQuickLaunch':
      task.quick = null;
      break;
    case 'takeOver':
      if (request) request.status = 'superseded';
      // An L2 or L3 run's turn may still run in the task's container: ending
      // it, and bringing its commits out, is the daemon's step outside the store.
      if (run?.mode === 'AFK' && runsContained(run.autonomy)) {
        const id = `takeover:${task.id}`;
        state.intents[id] = { id, verb: 'takeover', taskId: task.id };
      }
      if (run) endRun(run, 'taken over', at);
      // The factory stops publishing at an open-pr stage: HITL work is the operator's.
      if (atActionStage(task)) task.publishing = null;
      task.mode = 'HITL';
      task.autonomy = null;
      task.loop = null;
      // Its work is the operator's now: handed back AFK, its stages carry on,
      // and a red check at its gate gets a fix run again.
      task.fixRun = null;
      // What an AFK run was to open on is the operator's to say now.
      task.resumeWith = null;
      // A fresh session no run has started yet gives way to the one the
      // last run used: the operator steps into the conversation they saw.
      const lastSession = lastRun(state, task)?.sessionId;
      if (task.newSession && lastSession) {
        task.sessionId = lastSession;
        task.newSession = false;
      }
      startRun(state, task, at);
      break;
    case 'answer':
      if (answerCard(state, task, action.permission)) break;
      request!.status = 'answered';
      if (task.state === 'cancelled') break;
      // The daemon tries the failed step of a research child's publishing again; the child stays Done.
      if (task.state === 'done') {
        if (task.child?.research) task.child.research.problem = null;
        break;
      }
      // The daemon tries the failed step of its Push & open draft PR, or of
      // its merge, again; the root stays In review, or at its merge gate.
      if (task.state === 'in-review') {
        if (task.publishing) task.publishing.problem = null;
        // A failed merge is tried again on a fresh read of its gate.
        task.gate = null;
        break;
      }
      // A spec task left with skipped tickets goes as the operator chose.
      if (request!.skipped && task.ticketSet) {
        answerSkipped(state, task, request!, action);
        break;
      }
      // A spec task stalled on its held-back tickets reads them again,
      // launching those relabelled meanwhile.
      if (request!.kind === 'stage-blocked' && task.kind === 'spec' && task.ticketSet) {
        task.state = 'running';
        oweRead(task.ticketSet);
        break;
      }
      // And at its open-pr stage, which carries on.
      if (atActionStage(task) && task.publishing) {
        task.publishing.problem = null;
        task.state = 'running';
        break;
      }
      // Allow always's rules are the operator's file's, which the daemon added them to.
      if (request!.permission && allowsByRules(action.permission) && action.permission.allow === 'task') {
        addTaskRules(task, request!.permission, action.permission);
      }
      // The task's next L2 runs may reach them too.
      for (const host of action.allowHosts ?? []) if (!(task.egressHosts ??= []).includes(host)) task.egressHosts.push(host);
      if (request!.holdsRun) {
        // Resumes at once, even over the slot cap.
        run!.status = 'active';
        run!.parksAt = null;
        task.state = 'running';
      } else {
        if (request!.question) task.resumeWith = openingWithAnswers(request!.question, action.answers!);
        if (request!.permission) {
          const answer = action.permission!;
          if ('allow' in answer && answer.allow === 'once') (task.allowOnce ??= []).push(request!.permission.rule);
          task.resumeWith = openingWithVerdict(request!.permission, answer);
        }
        // An AFK stage that couldn't move on carries on, told why and how
        // its stage reports through the factory's tools.
        if (request!.kind === 'stage-blocked' && task.mode === 'AFK') {
          const opening = `The factory couldn’t move this task on: ${request!.reason}\n\n${AFK_RESUME}`;
          const stage = stageOf(task, task.stage);
          task.resumeWith = stage ? stageOpening(task, stage, opening) : opening;
        }
        // A retried run waits for the awaited children still open, as
        // the run that failed would have, and opens on their reports.
        requeue(state, task);
      }
      break;
    case 'requestChanges':
      stopPublishing(task, request);
      task.changesRequested = true;
      task.resumeWith = changesOpening(task, action.comments);
      task.state = 'queued';
      break;
    case 'markDone':
      // Unless finished anyway, the daemon found the task branch merged.
      finishRoot(task, request, { merged: !action.anyway });
      oweTicketSetRead(state, task);
      break;
    case 'prRead': {
      const asked = request?.kind === 'pr-closed-unmerged';
      if (action.state === 'merged') {
        finishMerged(state, task, request);
      } else if (action.state === 'closed' && !asked) {
        // A failed push to the closed PR has nothing left to update: the
        // closed PR asks instead. Never cancelled on the factory's own say.
        stopPublishing(task, request);
        addRequest(state, task, lastRun(state, task), 'pr-closed-unmerged', false, prClosedReason(task), at);
      } else if (action.state === 'open') {
        // Reopened on GitHub: nothing is left to ask.
        if (asked) request!.status = 'closed';
        else if (action.mergeable === 'mergeable') task.conflicted = false;
        else if (action.mergeable === 'conflicting' && updatesOnConflict(task) && !request) {
          // A ticket task's PR its base moved on under (ADR 0013): one update
          // run, resuming its session, merges the base in. At L2 the factory
          // pushes what it did once it is back In review.
          task.conflicted = true;
          task.resumeWith = updateOpening(state, task);
          task.state = 'queued';
        }
        if (task.state === 'in-review') readGate(state, task, action, request, at);
      }
      break;
    }
    case 'prMarkedReady':
      task.pr!.draft = false;
      task.gate!.step = 'merge';
      break;
    case 'prMerged':
      finishMerged(state, task, request);
      break;
    case 'mergeFailed': {
      // Retried once the operator answers, as a failed publishing step is.
      // The head or checks may have moved meanwhile: the gate is read again first.
      const what = action.step === 'ready' ? `mark ${task.id}’s PR #${task.pr!.number} ready` : `merge ${task.id}’s PR #${task.pr!.number}`;
      task.gate!.problem = `The factory couldn’t ${what} on GitHub as its App: ${action.reason} Fix it, then answer to try again.`;
      task.gate!.step = null;
      if (!request) addRequest(state, task, lastRun(state, task), 'github-write', false, task.gate!.problem, at);
      break;
    }
    case 'reopenPr':
      request!.status = 'answered';
      break;
    case 'ticketResolved':
      task.resolving = null;
      // Its ticket closed, the tickets it blocked may be takeable now.
      oweTicketSetRead(state, task);
      break;
    case 'specClosed':
      task.ticketSet!.closing = null;
      task.ticketSet!.problem = null;
      specResolved(state, task, request);
      break;
    case 'mapClosed':
      task.mapClosing = null;
      // A spec task whose spec closed is Done once its maps are.
      if (task.ticketSet && !isTerminal(task)) {
        task.ticketSet.problem = null;
        finishSpecTask(state, task, request);
      }
      break;
    case 'mapUnclosed':
      task.mapClosing!.problem = action.reason;
      if (task.ticketSet) task.ticketSet.problem = `The factory couldn’t close ${listed(task.mapClosing!.maps)} on GitHub: ${action.reason}`;
      break;
    case 'specUnclosed':
      task.ticketSet!.closing = { ...task.ticketSet!.closing, problem: action.reason };
      task.ticketSet!.problem = `The factory couldn’t close ${task.ticketSet!.spec} on GitHub: ${action.reason}`;
      break;
    case 'ticketSetRead': {
      const set = task.ticketSet!;
      set.problem = null;
      // A read started before the last one was owed leaves that one owed,
      // and steers nothing: the owed read does.
      if ((action.reads ?? 0) < (set.reads ?? 0)) break;
      set.reading = false;
      if (action.tickets) set.tickets = [...action.tickets];
      set.issues = structuredClone(action.issues);
      // The frontier: the open tickets with no open blockers, in sub-issue
      // order, that were neither launched nor skipped. Those labelled
      // ready-for-agent get AFK ticket tasks, ready-for-human HITL ones,
      // and the others are held back.
      set.toLaunch = action.issues
        .filter((issue) => readyNow(issue) && !set.launched[issue.ref] && !set.skipped?.includes(issue.ref))
        .map(({ ref }) => ref);
      // Tickets, none open, and no ticket task still at work: the spec
      // closes, or with none (or one closed already) the spec task is Done.
      const resolved = action.issues.length > 0 && action.issues.every(({ open }) => !open);
      const settled = Object.values(set.launched).every((id) => isTerminal(state.tasks[id]!));
      if (resolved && settled) {
        if (set.spec && action.specOpen !== false) set.closing = { problem: null };
        else specResolved(state, task, request);
        break;
      }
      // With nothing to launch and nothing in flight, the spec task asks the
      // operator about its skipped tickets, or else its held-back ones,
      // rather than wait silently.
      const held = action.issues.filter((issue) => heldBack(issue) && !set.launched[issue.ref] && !set.skipped?.includes(issue.ref));
      const skipped = action.issues.filter((issue) => issue.open && set.skipped?.includes(issue.ref));
      if (settled && set.toLaunch.length === 0 && !request) {
        if (skipped.length) raise(state, task, lastRun(state, task), 'stage-blocked', false, skippedReason(task, skipped, held), at, { skipped: skipped.map(({ ref }) => ref) });
        else if (held.length) raise(state, task, lastRun(state, task), 'stage-blocked', false, heldBackReason(task, held), at);
      }
      break;
    }
    case 'ticketSetUnread':
      task.ticketSet!.problem = `The factory couldn’t read ${task.id}’s tickets from GitHub: ${action.reason}`;
      break;
    case 'ticketTaskUnlaunched':
      task.ticketSet!.problem = `The factory couldn’t launch a ticket task on ${action.ticket}: ${action.reason}`;
      break;
    case 'ticketTaskLaunched': {
      const set = task.ticketSet!;
      const ticketTask = launchedTicketTask(task, action, at);
      ticketTask.id = nextId(state, 'task');
      ticketTask.goal = specTicketOpening(state, task, ticketTask);
      state.tasks[ticketTask.id] = ticketTask;
      set.toLaunch = set.toLaunch.filter((ref) => ref !== action.ticket);
      set.launched[action.ticket] = ticketTask.id;
      set.problem = null;
      break;
    }
    case 'ticketUnresolved':
      task.resolving = { problem: action.reason };
      break;
    case 'cleanedUp':
      // A child's branch went with its worktree, unless it was kept to merge.
      if (task.child && !task.cleanup!.keepBranch) task.child.branchDeleted = true;
      // A root's tree's kept child branches went with it.
      for (const id of action.childBranches ?? []) state.tasks[id]!.child!.branchDeleted = true;
      task.cleanup = null;
      task.transcripts = action.transcripts;
      break;
    case 'childBranchDeleted':
      task.child!.branchDeleted = true;
      break;
    case 'cleanupFailed':
      // Tried again later, keeping what it keeps.
      task.cleanup = { ...task.cleanup, problem: action.reason };
      break;
    case 'cancel':
      cancelSubtree(state, task, action.branch !== 'discard', at);
      // A spec task's cancel cascades to each of its ticket tasks not yet
      // merged, under the operator's one branch choice (ADR 0013).
      if (task.kind === 'spec') for (const ticketTask of unfinishedTicketTasks(state, task)) cancelSubtree(state, ticketTask, action.branch !== 'discard', at);
      // A cancelled ticket task's ticket stays open, and its spec task
      // launches it no more: it is skipped, and reads its tickets again.
      if (task.kind === 'ticket') skipTicket(state, task);
      break;
    case 'childCancelled':
      // An agent's own child: nothing of it is the operator's to keep.
      cancelSubtree(state, state.tasks[action.childId]!, false, at);
      break;
    case 'childSpawned': {
      const stage = action.preset.stages[0]!;
      const parentRun = run!;
      const child: Task = {
        id: nextId(state, 'task'),
        title: action.title,
        repo: task.repo,
        parent: task.id,
        child: {
          depth: depthOf(task) + 1,
          spawnedBy: { runId: parentRun.id, toolUseId: action.toolUseId },
          awaited: awaitsChild(parentRun, action),
          base: action.base,
          report: null,
          research: action.research ? { ticket: action.research.ticket, step: null, problem: null } : null,
        },
        progress: null,
        mode: 'AFK',
        // Lowered, never raised: the parent's level (L1 under HITL) is its
        // ceiling, and L2 at most, since a child never merges (ADR 0014). A
        // research child stays L1, for its open web (ADR 0007).
        autonomy: action.research || action.autonomy === 'L1' || (task.autonomy ?? 'L1') === 'L1' ? 'L1' : 'L2',
        priority: task.priority ?? 'normal',
        maxTurns: null,
        groups: [...task.groups],
        goal: null,
        operatorTier: null,
        // The agent's tier, else the stage's, held to the spawning run's.
        delegatedTier: clampTier(action.tier ?? stage.model ?? DEFAULT_TIER, parentRun.tier ?? nextTier(task)),
        worktree: { ...action.worktree },
        skillSet: task.skillSet,
        preset: structuredClone(action.preset),
        stage: stage.id,
        inputs: { prompt: action.goal.trim(), issues: [], issueKinds: [] },
        sessionId: action.sessionId,
        runIds: [],
        state: 'queued',
        createdAt: at,
        // A frozen copy of the parent's per-task rules and egress hosts.
        allowRules: [...(task.allowRules ?? [])],
        egressHosts: [...(task.egressHosts ?? [])],
      };
      child.goal = childOpening(state, task, child, action);
      state.tasks[child.id] = child;
      break;
    }
    case 'progressReported':
      task.progress = oneLine(action.status);
      break;
    case 'resultReported':
      task.child!.agentReport = { summary: action.summary.trim(), status: action.status.trim() || 'done', notes: action.notes.trim() };
      break;
    case 'retier':
      task.operatorTier = action.tier;
      break;
    case 'setAutonomy':
      task.autonomy = clampAutonomy(action.autonomy, stageOf(task, task.stage));
      break;
    case 'setSlotCap':
      state.slotCap = action.cap;
      break;
    case 'setKeepAwake':
      state.keepAwake = action.on;
      break;
    case 'runStarted':
      run!.cli = { pid: action.pid, createdAt: action.createdAt };
      run!.model = action.model;
      handReports(state, run!);
      break;
    case 'questionAsked': {
      // A quick launch's card is cut to the questions it has left to ask.
      // Past them, its grill is done: the handoff sheet opens instead,
      // interrupting the agent, so the card never shows.
      const left = task.quick ? QUICK_QUESTIONS - task.quick.questions : Infinity;
      if (left <= 0) task.quick!.done = true;
      else run!.question = { ...action.question, questions: action.question.questions.slice(0, left) };
      break;
    }
    case 'advanceProposed':
      run!.proposal = { kind: 'advance', reason: action.reason };
      break;
    case 'handoffProposed':
      run!.proposal = { kind: 'handoff', reason: action.reason };
      break;
    case 'handoffOpened': {
      // A sheet a stop found unconfirmed opens again as it was.
      if (!task.handoff) {
        task.handoff = { ...newHandoffSheet(state, task, action.readiness), ...task.handoffDraft };
        task.handoffDraft = null;
      }
      const sheet = task.handoff;
      sheet.readiness = action.readiness;
      if (action.ticketSets !== undefined) sheet.ticketSets = structuredClone(action.ticketSets);
      // A quick launch ends on its handoff sheet: backing out of it keeps the conversation going.
      task.quick = null;
      if (sheet.brief) break;
      if (!run) {
        // A parked conversation is resumed just to write the brief.
        startRun(state, task, at, { opening: BRIEF_REQUEST });
        sheet.asked = true;
        break;
      }
      run.proposal = null;
      if (run.turn === 'operator') {
        // The executor asks at once, or again when the agent's turn ended without writing it.
        run.turn = 'agent';
        sheet.asked = true;
      } else if (!sheet.asked) {
        // The executor interrupts the turn: what it waited on goes with it.
        run.queued = [];
        run.question = null;
        if (run.permission) run.permission = null;
      }
      break;
    }
    case 'readinessRead':
      task.handoff!.readiness = action.readiness;
      break;
    case 'briefWritten':
      // A brief written after the operator backed out stays in the conversation only.
      if (task.handoff && !task.handoff.brief) task.handoff.brief = tidyBrief(action.brief);
      break;
    case 'stageAdvanced': {
      const plan = planAdvance(state, task, action.skip, action.end);
      if ('refusal' in plan) break;
      if (run) endRun(run, 'completed', at);
      // The work loop's ticket is done: the factory reads the map again.
      if (plan.kind === 'finish-ticket') {
        task.loop = picking();
        task.state = 'queued';
        break;
      }
      // Past the last stage, or ended there, the root task is the operator's to review.
      if (plan.kind === 'end' || !plan.to) {
        // Ended at its cleared map, a wayfinder task closes the map: its
        // destination was the decisions themselves.
        const maps = plan.kind === 'end' ? mapsOf(state, task) : [];
        if (maps.length) task.mapClosing = { maps, spec: null, problem: null };
        task.loop = null;
        // A setup task's work reaches its PR without the operator (ADR 0010).
        reachReview(task);
        break;
      }
      const { to, jumped } = plan;
      // The retired Ralph loop's stage asks the operator, whatever its args.
      if (isRetiredLoop(to)) {
        enterStage(task, to, action.sessionId, jumped?.context === 'fresh');
        blockRetiredLoop(state, task, at);
        break;
      }
      const filled = fillOpening(to, (variable) => jumpValue(state, task, jumped, variable));
      if ('missing' in filled) {
        // The stage raises an attention request instead of starting. The
        // task stays at the stage it was leaving, to advance again from.
        raise(state, task, lastRun(state, task), 'stage-blocked', false, cantFill(task, to, filled.missing), at);
        break;
      }
      task.loop = null;
      // A stage jumped to starts fresh when the one jumped over would have.
      enterStage(task, to, action.sessionId, jumped?.context === 'fresh');
      if (!enterLoop(state, task, to)) startRun(state, task, at, { opening: filled.opening });
      break;
    }
    case 'turnEnded':
      if (action.context) task.context = { ...action.context };
      // A card the turn ended without is dropped. What waited is delivered
      // now, so the agent answers it at once: the brief, once a handoff
      // interrupted the turn.
      run!.question = null;
      if (run!.permission) run!.permission = null;
      if (task.handoff && !task.handoff.asked && !task.handoff.brief) task.handoff.asked = true;
      else if (run!.queued.length) run!.queued = [];
      else run!.turn = 'operator';
      // A quick launch's grill is done once a turn of it ends on the operator's.
      if (task.quick && run!.turn === 'operator') task.quick.done = true;
      break;
    case 'runCompleted': {
      logDenials(run!, action.deniedHosts);
      // Whatever the agent said, a run that ends with awaited children it
      // hasn't had the reports of waits on them, holding no slot (ADR 0009).
      handReports(state, run!);
      if (awaitedChildren(state, task).length) {
        endRun(run!, 'waiting on children', at);
        task.state = 'awaiting-children';
        break;
      }
      endRun(run!, 'completed', at);
      // A child ends Done and reports up: only the root is reviewed.
      if (task.child) {
        finishChild(state, task, run!, action);
        break;
      }
      // A run of an AFK stage moves the task on by itself. Any other (a task
      // with no preset, or one handed off with no AFK stage ahead) is its last.
      const from = stageOf(task, run!.stage);
      if (from?.mode !== 'AFK' || task.changesRequested || task.conflicted || task.fixRun) {
        reachReview(task);
        break;
      }
      if (task.findings?.found.length && !task.findings.fixPass && stageReports(from).includes('findings')) {
        // The review's one fix pass, resuming its session on what it found.
        // Once a run of it completes, the stage moves on whatever is left
        // over: never a loop.
        task.findings.fixPass = true;
        task.resumeWith = fixContext(task);
        task.state = 'queued';
        break;
      }
      const unmet = unmetExit(state, task, from);
      if (unmet) raise(state, task, run, 'stage-blocked', false, unmet, at);
      else advanceFrom(state, task, from, run, action.sessionId, at);
      break;
    }
    case 'findingsReported': {
      // The review's report replaces what it reported before; the fix
      // pass's says what is left over.
      const findings = action.findings.map((finding) => finding.trim()).filter(Boolean);
      if (task.findings?.fixPass) task.findings.leftOver = findings;
      else task.findings = { found: findings, fixPass: false, leftOver: findings };
      break;
    }
    // Metered on the run that used it, live or not.
    case 'usageSampled': {
      const metered = state.runs[action.runId]!;
      // An ended run no longer knows what its messages were counted at, so
      // a message still streaming adds nothing: a late total corrects it.
      if (metered.status === 'ended') break;
      const counted = metered.countedMessages?.[action.messageId] ?? NO_USAGE;
      const added = grown(counted, action.usage);
      metered.countedMessages = { ...metered.countedMessages, [action.messageId]: plus(counted, added) };
      // A run streaming again has its usage window back.
      metered.waitingForWindow = null;
      meter(state, metered, { [action.model]: added }, at);
      break;
    }
    case 'usageTotaled': {
      const metered = state.runs[action.runId]!;
      meter(state, metered, correction(action.models, othersInSession(state, metered), metered.usage ?? {}), at);
      // The total covers every message so far: none is counted again.
      if (metered.status !== 'ended') metered.countedMessages = {};
      break;
    }
    case 'usageSnapshotSeen': {
      const { window, status, spent, resetsAt } = action;
      state.snapshots[window] = updatedSnapshot(state.snapshots[window], { window, status, spent, resetsAt, seenAt: at });
      break;
    }
    case 'prBodyWritten':
      task.prBody = prBody(task, action.body);
      task.prTitle = prTitleOf(action.title);
      break;
    case 'runFailed': {
      // The request a suspended run waited on can't resume it any more.
      if (request?.holdsRun) request.status = 'superseded';
      // An AFK run failed with its weekly limit spent says when it resets
      // (ADR 0008): the CLI's failure carries only the API's message.
      const weekly = task.mode === 'AFK' ? weeklySpentUntil(state.snapshots, run!.model, at) : null;
      endRun(run!, 'failed', at);
      logDenials(run!, action.deniedHosts);
      const reason = weekly === null ? action.reason : weeklyLimitReason(weekly, action.reason);
      raise(state, task, run!, 'failure', false, withWakeHint(withDenials(reason, action.deniedHosts), action.afterWake), at, {
        deniedHosts: action.deniedHosts,
      });
      break;
    }
    case 'windowWaited':
      // A usage limit is waited out in place, holding the run's slot
      // (ADR 0008). A weekly one resets beyond the cap, so the CLI fails
      // the run instead; one that resets within it is waited out too.
      run!.waitingForWindow = at + action.waitMs;
      break;
    case 'attentionRaised': {
      suspend(run!, at);
      // Named by what it asks.
      const reason = action.question.questions.map(({ question }) => question).join(' ');
      raise(state, task, run!, 'question', true, reason, at, { question: action.question });
      break;
    }
    case 'permissionAsked': {
      // The executor lets a call the operator allowed through, using up a
      // rule allowed once.
      const grant = grantFor(task, run!, action);
      if (grant === 'once') run!.allowOnce!.splice(run!.allowOnce!.indexOf(ruleFor(action.call)), 1);
      if (grant) break;
      const { id, tool, summary } = action.call;
      const parts = leftUncovered(task, action);
      const permission = { id, tool, summary, rule: ruleFor(action.call), proposed: proposals(parts) };
      // A HITL run asks in its conversation: its run stays live, holding no slot.
      if (task.mode === 'HITL') {
        run!.permission = permission;
        break;
      }
      suspend(run!, at);
      // Named by the parts no rule covers.
      const problem = action.rulesProblem && ` (${action.rulesProblem.replace(/\.$/, '')}, so its rules granted nothing.)`;
      raise(state, task, run!, 'permission', true, `${tool}: ${parts.map((part) => part.summary).join(' · ')}${problem ?? ''}`, at, { permission });
      break;
    }
    case 'artifactsSeen': {
      // One artifact per file or issue of a task, however often it is seen.
      const existing = (test: (artifact: Artifact) => boolean) => artifactsOf(state, task).find(test);
      const runId = task.runIds.at(-1)!;
      for (const { path, committed } of action.files) {
        const file = existing((artifact) => artifact.kind === 'file' && artifact.path === path);
        if (file?.kind === 'file') file.committed = committed;
        else addArtifact(state, { taskId: task.id, runId, kind: 'file', path, committed });
      }
      for (const url of action.issues) {
        if (!existing((artifact) => artifact.kind === 'issue' && artifact.url === url)) {
          addArtifact(state, { taskId: task.id, runId, kind: 'issue', url });
        }
      }
      break;
    }
    case 'removeRepo':
      closeRepoRequest(state, action.repo);
      delete state.repositories[action.repo];
      break;
    case 'repoRegistered':
      state.repositories[action.repo] = {
        id: action.repo,
        path: action.path,
        baseBranch: action.baseBranch,
        defaultPreset: action.defaultPreset,
        missing: false,
        registeredAt: at,
      };
      break;
    case 'repoMissing': {
      state.repositories[action.repo]!.missing = true;
      // One request per repository, however many runs it holds back.
      if (openRepoRequest(state, action.repo)) break;
      const request: AttentionRequest = {
        id: nextId(state, 'request'),
        repo: action.repo,
        taskId: null,
        runId: null,
        kind: 'repo-missing',
        status: 'open',
        holdsRun: false,
        reason: action.reason,
        raisedAt: at,
      };
      state.requests[request.id] = request;
      break;
    }
    case 'repoMoved':
      state.repositories[action.repo]!.path = action.path;
    // falls through: the clone is in place at its new path.
    case 'repoFound':
      state.repositories[action.repo]!.missing = false;
      closeRepoRequest(state, action.repo);
      break;
    case 'appChecked':
      state.repositories[action.repo]!.app = action.check;
      break;
    case 'skillsChecked':
      state.repositories[action.repo]!.skills = action.check;
      break;
    case 'deadlinesDue':
      for (const overdue of overdueRuns(state, at)) park(state, state.tasks[overdue.taskId]!, overdue, at);
      break;
    case 'runsReconciled':
      reconcile(state, action.interruption, action.replayed ?? [], action.found, at);
      break;
    case 'intentJournaled':
      state.intents[action.intent.id] = structuredClone(action.intent);
      break;
    case 'intentDropped': {
      const intent = state.intents[action.intentId]!;
      // A handoff rolled back keeps what the operator confirmed on its
      // sheet, which a stop saves as the draft.
      if (intent.verb === 'handoff' && task.handoff) {
        const { brief, continueAs, autonomy, tier, maxTurns } = intent.handoff;
        Object.assign(task.handoff, structuredClone({ brief, continueAs, autonomy, mergePolicy: policyOf(intent.handoff), tier, maxTurns }));
      }
      delete state.intents[action.intentId];
      break;
    }
    case 'dismiss':
      state.requests[action.requestId]!.status = 'closed';
      break;
    case 'mapRead':
      readMap(state, task, action, at);
      break;
    case 'ticketsUnread':
      raise(state, task, lastRun(state, task), 'failure', false, `The factory couldn’t read ${task.id}’s tickets from GitHub: ${action.reason}`, at);
      break;
    case 'pushAndOpenPr':
      task.publishing = { step: 'push', problem: null };
      break;
    case 'setupCommitted':
      task.publishing = action.publish ? { step: 'push', problem: null } : null;
      break;
    case 'branchPushed':
      // A root with a draft PR already has it updated by the push.
      task.publishing = task.pr ? null : { step: 'open-pr', problem: null };
      task.pushed = true;
      task.branchOnGitHub = true;
      // What the fix run left is on GitHub: the PR's head is that commit now.
      if (task.fixRun) task.fixRun.pushed = action.commit;
      if (!task.publishing) actionStagePublished(state, task, at);
      break;
    case 'prOpened':
      task.pr = { ...action.pr };
      task.publishing = null;
      actionStagePublished(state, task, at);
      break;
    case 'pushRefused': {
      // The App has no Workflows permission (ADR 0004): the operator pushes by
      // hand, and once they answer the push finds the branch already pushed.
      const { branch } = task.worktree!;
      const files = action.workflowFiles.join(', ');
      failPublishing(state, task, request, `${branch} changes workflow files (${files}), which the factory’s App may not push. ` +
        `Push it by hand (\`git push origin ${branch}\`), then answer to open the draft PR.`, at);
      break;
    }
    case 'publishFailed': {
      // Retried once the operator answers, and never as the operator (ADR 0004).
      if (action.step === 'commit') {
        failPublishing(state, task, request, `The factory couldn’t commit ${task.id}’s setup files: ${action.reason} Fix it, then answer to try again.`, at);
        break;
      }
      const what = action.step === 'push' ? `push ${task.worktree!.branch}` : `open ${task.id}’s draft PR`;
      failPublishing(state, task, request, `The factory couldn’t ${what} on GitHub as its App: ${action.reason} Fix it, then answer to try again.`, at);
      break;
    }
  }
}

// `routes` is the routing table each run the action starts is routed
// through (ADR 0009). While it can't be read, queued AFK tasks wait, and an
// action that would start a run itself is refused. So it is while the daemon
// starts no new run, as it stops or waits to restart: `holdRuns` says why.
export function reduce(state: Lifecycle, action: LifecycleAction, at: number, routes: Routes, { holdRuns = null }: { holdRuns?: string | null } = {}): Reduction {
  const refusal = guard(state, action);
  if (refusal) return { state, refusal };
  const next = structuredClone(state);
  apply(next, action, at);
  // The action is the last step of the intent it finishes.
  if ('intent' in action && typeof action.intent === 'string') delete next.intents[action.intent];
  wakeParents(next);
  placeInQueue(state, next);
  const held = 'unreadable' in routes ? routes.unreadable : holdRuns;
  if (held === null) schedule(next, at);
  const started = Object.values(next.runs).filter((run) => !state.runs[run.id]);
  if (started.length) {
    if ('unreadable' in routes) return { state, refusal: routes.unreadable };
    if (holdRuns !== null) return { state, refusal: holdRuns };
    for (const run of started) run.model = route(routes, run.tier!).model;
  }
  armIdleParks(next, at);
  resetCrashCounts(state, next);
  return { state: next, refusal: null };
}

// A run that ends any way but interrupted ends the crash loop its task was
// in, if any (ADR 0003): a run the guard failed included.
function resetCrashCounts(before: Lifecycle, after: Lifecycle): void {
  for (const run of Object.values(after.runs)) {
    if (run.status !== 'ended' || run.outcome === 'interrupted' || before.runs[run.id]?.status === 'ended') continue;
    const task = after.tasks[run.taskId]!;
    if (task.uncleanStarts) task.uncleanStarts = 0;
  }
}

// Gives each task that has just become Queued the next place in the queue.
function placeInQueue(before: Lifecycle, after: Lifecycle): void {
  for (const task of Object.values(after.tasks)) {
    if (task.state === 'queued' && before.tasks[task.id]?.state !== 'queued') task.queuePlace = ++after.counters.queue;
  }
}

// A HITL run's idle clock (ADR 0003): its park deadline is set when the run
// starts waiting on the operator, and cleared once it no longer does.
function armIdleParks(state: Lifecycle, at: number): void {
  for (const run of Object.values(state.runs)) {
    if (run.mode !== 'HITL') continue;
    if (waitsOnOperator(run)) run.parksAt ??= at + IDLE_PARK_MS;
    else run.parksAt = null;
  }
}
