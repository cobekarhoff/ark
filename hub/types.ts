/**
 * What `/api/snapshot` and the `/events` stream carry. One background reader builds it; request
 * handlers only send the last serialized copy.
 *
 * Each source (ark files, Orca, Plannotator, GitHub, usage) publishes when its own read returns.
 * A source keeps its last good value. `sources.<name>.read_at` is, while `ok`, the start of the
 * healthy period (the time of the first good read, or of the first one after a failure), so an
 * unchanged read changes nothing and sends no push; while not `ok` it is the time of the last
 * good read. A source with `ok: false` and `read_at: null` has never answered: its data is
 * `"unknown"` (or `null` for a single value), never an empty list. With `ok: false` and a
 * `read_at`, the data is the last good value and the stale chip shows its age in minutes.
 *
 * Costs are USD numbers, or `null` when unknown (no session found, one message without a price,
 * or the usage index has not finished its first build). Times are ISO strings.
 */

import type { Phase, PhaseGate, StepStatus } from "../cli/lifecycle.ts";
import type { QueueTask } from "../cli/orca.ts";
import type { TimeSplit } from "../cli/time-split.ts";
import type { Roadmap } from "./roadmap.ts";

export type SourceName =
  | "ark"
  | "orca"
  | "plannotator"
  | "github"
  | "usage"
  | "providerLimits"
  | "agentWait"
  | "evidence"
  | "queue";
/** What a stale source leaves wrong on the page: the stale chip lists it. Exhaustive over SourceName. */
export const sourceAffects: Record<SourceName, string> = {
  ark: "Runs, gates, steps and the review queue",
  orca: "Agents, stuck agents and terminals",
  plannotator: "Plannotator review links and answers",
  github: "Merge requests and checks",
  usage: "Cost and token usage",
  providerLimits: "Provider limits in the header",
  agentWait: "Time agents waited on you",
  evidence: "Test evidence of a run",
  queue: "Orca task queue and merge order",
};
export type SourceStatus = { ok: boolean; read_at: string | null };

export type { StepStatus };

/** One provider and window (`5h` or `7d`) of `omp usage --json`. A field the tool did not give is null, never a guess. */
export type ProviderWindow = {
  provider: string;
  window: "5h" | "7d";
  used_fraction: number | null;
  /** ISO time the window resets. */
  resets_at: string | null;
  /** ISO time `omp` fetched the figure from the provider. */
  fetched_at: string | null;
};

/**
 * What an agent does now, from `orca worktree ps --agent-wait --json`:
 * `waiting on a prompt`, `idle N min`, `working`, `done` (Orca state `done`: never stuck), or
 * `unknown` when Orca did not list the agent or the field it needs is missing.
 */
export type AgentActivity = {
  kind: "waiting" | "idle" | "working" | "done" | "unknown";
  text: string;
  /** Last non-empty line of the agent's last message, for the Stuck agents list. */
  last_line: string | null;
};

export type CheckView = {
  name: string;
  /** Only an http(s) link: anything else is dropped. */
  url: string | null;
  result: "pass" | "fail" | "pending";
};

/** One JUnit testcase whose name starts with an AC id of the run. */
export type ProofCase = {
  name: string;
  file: string | null;
  line: number | null;
  result: "pass" | "fail" | "skipped";
};

export type CriterionEvidence = {
  id: string;
  /** The status in `state.json`. */
  status: string;
  proof: ProofCase[];
};

/** P1, P2 and P3 headings of the newest reviewer findings file. Whether a finding is open or fixed is not recorded. */
export type FindingsView = {
  /** Path inside the run folder, e.g. `findings/hub-review.md`. */
  path: string;
  /** The route that serves the file. */
  link: string;
  p1: number;
  p2: number;
  p3: number;
};

/** Evidence of a run in `merge_requests_open`; other runs have none. */
export type RunEvidence = {
  criteria: CriterionEvidence[];
  findings: FindingsView | null;
};

/**
 * Steps done of the plan, the round, and the time in the current step against the median and p90 of
 * its role across closed runs. There is no ETA.
 */
export type RunProgress = {
  steps_done: number;
  steps_total: number;
  round: number;
  round_budget: number;
  /** The running step; null when no step runs. */
  current: {
    step: string;
    role: string;
    started_at: string;
    /** Median and p90 in seconds; null when no closed run has a finished step of the role. */
    typical_seconds: number | null;
    slow_above_seconds: number | null;
  } | null;
};

/** Seconds of a finished step by role, across closed runs. */
export type RoleTimes = Record<string, { median: number; p90: number; count: number }>;

/** One step of `plan.yml`: harness and model come from the plan, status from the run events. */
export type PlanStepView = {
  id: string;
  role: string;
  harness: string;
  model: string;
  needs: string[];
  status: StepStatus;
  cost_usd: number | null;
  /** When the step started (ISO), or null while it has not started. */
  started_at: string | null;
  /** Why the human or the run lead must act before this step goes on, or null. */
  waiting: Wait | null;
};

/** Something an open run waits for: a worker's question or a blocked report that nobody has read yet. */
export type Wait = {
  /** The plan step that asked, or null when Orca could not tell which step. */
  step: string | null;
  reason: string;
  since: string;
};

export type Agent = {
  role: string;
  /** `omp`, `claude`, `codex`, ...: null when Orca did not name it. */
  harness: string | null;
  /** What Orca reports, else the model of the agent's last session message (ARK-293). */
  model: string | null;
  title: string;
  /** The plan step this agent works on, from its Orca task title; null for a lead or Chief. */
  step: string | null;
  /** Harness and model from the plan step or, for a run lead, `roles.chief` of `ark.yml`: set only while `model` is unknown, so the row labels it. */
  planned: { harness: string; model: string; source: "plan" | "configured" } | null;
  /** The Orca terminal handle, or null when Orca named none. */
  terminal: string | null;
  /** Only `live` (terminal connected) can be focused; `running` is a `structworker_*` session Orca lists no terminal for. */
  presence: "live" | "running" | "ended";
  activity: AgentActivity;
};

export type MergeRequestView = {
  repo: string;
  url: string;
  number: number;
  /** `unknown` when `gh pr view` has never answered for this MR: never a guess. */
  state: "open" | "merged" | "closed" | "unknown";
  ci: "passing" | "failing" | "pending" | "unknown";
  checks: CheckView[];
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  created_at: string | null;
};

export type GateKind = PhaseGate;

export type Gate = {
  id: string;
  run: string;
  project: string;
  ticket: string;
  kind: GateKind;
  /** What the human is asked. Shown when there is no Plannotator review to link. */
  question: string;
  /** The Plannotator review of the gate document, or null when none is open (or Plannotator is unknown). */
  review_url: string | null;
  since: string;
};

export type RunView = {
  run: string;
  project: string;
  ticket: { id: string; title: string };
  phase: Phase;
  round: number;
  started_at: string;
  updated_at: string;
  /** Null until `plan.yml` exists and parses. */
  plan: PlanStepView[] | null;
  merge_requests: MergeRequestView[];
  /** Live agents of the run, or "unknown" until Orca has answered once. */
  agents: Agent[] | "unknown";
  /** What the run waits for (empty while Orca is unknown). */
  waiting: Wait[];
  progress: RunProgress | null;
  /** Only for a run in `merge_requests_open`; null until the evidence source has read it. */
  evidence: RunEvidence | null;
  cost_usd: number | null;
};

/** The text sections of one backlog ticket, as plain strings, read in the background and sent in the snapshot. */
export type TicketDocument = {
  problem: string;
  change: string;
  evidence: string;
  criteria: TicketCriterionView[];
};

/** `id` is the local `AC<k>` (an old `<ticket>-AC<k>` reads the same). `verified_by` is `[]` when the file does not hold a list of strings. */
export type TicketCriterionView = {
  id: string;
  text: string;
  method: string;
  verified_by: string[];
};

/** An AC that a test case verifies: the ticket id and the local AC id. */
export type CaseRef = { ticket: string; criterion: string };

export type CaseVersion = { commit: string; time: string; changed_by: string };

/**
 * One `verified_by` id of a ticket, read on request. `{ id, missing: true }` when no case file or
 * evidence holds it. A local case has title, level, technique, priority, risk, status, changed_by and
 * versions (newest first), and `reason` when retired. A zephyr case has name, status and sha from
 * `result.json`, and `version` only when that file has one.
 */
export type TestCaseRecord = {
  id: string;
  missing?: true;
  title?: string;
  name?: string;
  level?: string;
  technique?: string;
  priority?: string;
  risk?: string;
  status?: string;
  reason?: string;
  changed_by?: string;
  versions?: CaseVersion[];
  sha?: string;
  version?: string | number;
  verifies?: CaseRef[];
};

export type TicketCases = { source: "local" | "zephyr"; cases: TestCaseRecord[] };

export type CaseResult = "pass" | "fail" | "not run";
export type CommandRun = { command: string; output: string; exit: number | null };
export type SideEvidence = { result: CaseResult; sha: string | null; runs: CommandRun[] };
/** A screenshot checkpoint: run-relative image paths for the base (before) and head (after) side. */
export type Checkpoint = { name: string; before: string | null; after: string | null };
export type PlanCaseEvidence = {
  id: string;
  action: string;
  level: string;
  base: SideEvidence;
  head: SideEvidence;
  verifies: CaseRef[];
  checkpoints: Checkpoint[];
};
/** A section of an evidence file: its heading, its text, the images its lines name, and its sub-sections. */
export type EvidenceSection = {
  title: string;
  text: string;
  images: string[];
  children: EvidenceSection[];
};
export type AcEvidence = {
  id: string;
  method: string;
  /** Null when `results/evidence/<AC id>.md` is missing or has the wrong shape for its method. */
  sections: EvidenceSection[] | null;
};
export type RunTestEvidence = { cases: PlanCaseEvidence[]; criteria: AcEvidence[] };

export type TicketView = {
  project: string;
  id: string;
  title: string | null;
  status: string;
  /** `kind` of the front matter; null when it names none. */
  kind: string | null;
  milestone: string | null;
  depends_on: string[];
  /** First sentence of the `## Problem` or `## Why` section; null when there is none. */
  why: string | null;
  /** Size and mtime of the ticket file: any edit changes it, so the open ticket page reads its document again. */
  signature: string;
};

/**
 * The roadmap of one project, from `$ARK_HOME/projects/<project>/ROADMAP.md`: the `readRoadmap`
 * roadmap, `{ error }` (message and line) when the file does not read, or `{ none }` with the
 * project's `ticket_source` (local, github or jira) when it has no `ROADMAP.md`.
 */
export type ProjectRoadmap = Roadmap | { error: string } | { none: string };

/** The newest run of a ticket, open or closed, for the Map. A ticket with no entry has no run. */
export type TicketRunView = {
  project: string;
  ticket: string;
  run: string;
  phase: Phase;
  /** An open run with a question or blocked report nobody has read. */
  waiting: boolean;
  /** Closed run: from `metrics.json`. Open run: from the usage index. */
  cost_usd: number | null;
  /** Every run of the ticket, newest first. Small on purpose: an open run has no outcome and no cost here; a closed run's cost_usd is null when metrics.json holds none. */
  all: { run: string; phase: Phase; outcome: string | null; cost_usd: number | null }[];
};

/**
 * Master Chief's queue for one project: the ready Tasks, then the pending Tasks, with the
 * `concurrency` of `ark.yml` (null when that file does not load). `open` counts the project's open
 * runs, as `ark chief state` does. `unavailable` is the reason the queue could not be read (never
 * an empty queue).
 */
export type ProjectQueue = { project: string; open: number } & (
  | { concurrency: number | null; tasks: QueueTask[] }
  | { unavailable: string }
);

export type Snapshot = {
  generated_at: string;
  sources: Record<SourceName, SourceStatus>;
  /** Open runs only: Orca never removes runs, so closed ones stay out of the page. */
  runs: RunView[] | "unknown";
  gates: Gate[] | "unknown";
  tickets: TicketView[] | "unknown";
  /** By project. */
  roadmap: Record<string, ProjectRoadmap> | "unknown";
  ticket_runs: TicketRunView[] | "unknown";
  /** Per provider and window of `omp usage --json`. */
  provider_limits: ProviderWindow[] | "unknown";
  /** Median and p90 of step time by role, from closed runs. */
  role_times: RoleTimes;
  /** One entry for each project, `"unknown"` until the queue source has answered once. */
  queues: ProjectQueue[] | "unknown";
};

/** One decision of a run, from `events.ndjson`: `why` is a plain sentence made from the event payload. */
export type TimelineEntry = {
  time: string;
  type: string;
  why: string;
  /** Test counts of `test.completed`; null for every other type. */
  counts: { pass: number; fail: number; missing: number; notRun: number } | null;
  /** The merge request of `merge_request.opened`; null for every other type. */
  url: string | null;
};

/** Who a session file belongs to: a plan step, the run lead, or no one (shown, never hidden). */
export type SessionOwner =
  | { kind: "step"; step: string }
  | { kind: "lead" }
  | { kind: "unassigned" };

export type SessionFile = {
  /** The session file path: the transcript request names it, the server checks it belongs to the run. */
  file: string;
  harness: "omp" | "claude" | "codex";
  /** First timestamp of the file (ISO), or null when the head holds none. */
  start: string | null;
  /** Last write (ISO). */
  end: string;
  size: number;
  cwd: string;
  owner: SessionOwner;
};

/** The summary of a closed run. Every metrics value is "not recorded" when metrics.json is missing or damaged. */
export type ClosedBand = {
  /** `run.started` to `run.closed`, in seconds. */
  wall_seconds: number | null;
  /** Criteria that pass (passing or manual ok) of all criteria. Zero criteria is 0 of 0: the page shows a dash. */
  criteria: { passing: number; total: number };
  cost_usd: number | "not recorded";
  rework_rounds: number | "not recorded";
  /** The entries of escaped-defects.yml for this run: free text, never HTML. */
  escaped_defects: { ticket: string; note: string; fix: string }[];
};

export type { TimeSplit };

/** What `GET /api/run/<run>` answers: any run, open or closed, read on request and never part of the snapshot. */
export type RunDetail = {
  view: RunView;
  closed: boolean;
  outcome: string | null;
  /** Time of `run.closed`, or null for an open run. */
  closed_at: string | null;
  /** Null for an open run. */
  band: ClosedBand | null;
  /** Where the run's time went, from the events: to `run.closed`, or to now for an open run. */
  time_split: TimeSplit;
  timeline: TimelineEntry[];
  /** Run files that exist, relative to the run folder: plan.md, strategies.md, retro.md, findings/*, results/*. */
  files: string[];
  /** Session files under the run folder, each mapped whole to a step, the run lead or unassigned. */
  sessions: SessionFile[];
  /** False until the usage index has read the session roots once: an empty list then means unknown. */
  sessions_ready: boolean;
};

export type TranscriptEntry =
  | { kind: "message"; role: string; time: string | null; text: string }
  | { kind: "thinking"; time: string | null; text: string }
  | {
      kind: "tool";
      time: string | null;
      name: string;
      /** Arguments as JSON: every string field over 20,000 characters is cut with a note inside the field, so the text stays valid JSON. */
      args: string;
      /** What the call does in one line: its command, file path or pattern, cut to 300 characters. Empty when the arguments name none. */
      summary: string;
      /** Id the result route takes. Absent when the record held no string id. */
      callId?: string;
      status: "ok" | "error" | "unknown";
      /** The first line of the result, cut to 300 characters. The full result comes from the result route. */
      result: string;
      /** Length in characters of the whole result, before any cut. 0 while the call has no result. */
      resultSize: number;
    };

/** One page of a transcript: at most 200 entries. `next` is the byte offset of the next page, or null at the end. */
export type TranscriptPage = { entries: TranscriptEntry[]; next: number | null; size: number };

/** One full tool result, cut at 64,000 characters. `size` is its length before the cut, `cut` says whether it was cut. */
export type TranscriptResult = { text: string; size: number; cut: boolean };
