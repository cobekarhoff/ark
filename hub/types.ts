/**
 * What `/api/snapshot` and the `/events` stream carry. One background reader builds it; request
 * handlers only send the last serialized copy.
 *
 * Each source (ark files, Orca, Plannotator, GitHub, usage) publishes when its own read returns.
 * A source keeps its last good value. `sources.<name>.read_at` is the server time of that last
 * good read. A source with `ok: false` and `read_at: null` has never answered: its data is
 * `"unknown"` (or `null` for a single value), never an empty list. With `ok: false` and a
 * `read_at`, the data is the last good value and the page shows "as of N s ago".
 *
 * Costs are USD numbers, or `null` when unknown (no session found, one message without a price,
 * or the usage index has not finished its first build). Times are ISO strings.
 */

export type SourceName =
  | "ark"
  | "orca"
  | "plannotator"
  | "github"
  | "usage"
  | "providerLimits"
  | "agentWait"
  | "evidence";
export type SourceStatus = { ok: boolean; read_at: string | null };

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "stopped";

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
 * `waiting on a prompt`, `idle N min`, `working`, or `unknown` when Orca did not list the agent
 * or the field it needs is missing.
 */
export type AgentActivity = {
  kind: "waiting" | "idle" | "working" | "unknown";
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
  model: string | null;
  title: string;
  /** The plan step this agent works on, from its Orca task title; null for a lead or Chief. */
  step: string | null;
  /** Harness and model from the plan step or, for a run lead and Master Chief, `roles.chief` of `ark.yml`: shown when Orca reports none, labelled when they differ. */
  planned: { harness: string; model: string; source: "plan" | "configured" } | null;
  /** The Orca terminal handle, or null when Orca named none. */
  terminal: string | null;
  /** True when Orca lists the terminal as connected: only then can the hub focus it in Orca. */
  live: boolean;
  /** True when Orca's worker-list shows the agent working but `terminal list` does not list its terminal (a `structworker_*` agent session): the page says to open it from its chat tab. Never true with `live`. */
  running: boolean;
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

export type GateKind = "criteria" | "strategy" | "plan" | "escalation";

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
  phase: string;
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

export type TicketView = {
  project: string;
  id: string;
  title: string | null;
  status: string;
  milestone: string | null;
  depends_on: string[];
};

/** The newest run of a ticket, open or closed, for the Map. A ticket with no entry has no run. */
export type TicketRunView = {
  project: string;
  ticket: string;
  run: string;
  phase: string;
  /** An open run with a question or blocked report nobody has read. */
  waiting: boolean;
  /** Closed run: from `metrics.json`. Open run: from the usage index. */
  cost_usd: number | null;
  /** Every run of the ticket, newest first: names and phases only, so a long history stays small. */
  all: { run: string; phase: string }[];
};

export type Snapshot = {
  generated_at: string;
  sources: Record<SourceName, SourceStatus>;
  /** Open runs only: Orca never removes runs, so closed ones stay out of the page. */
  runs: RunView[] | "unknown";
  gates: Gate[] | "unknown";
  tickets: TicketView[] | "unknown";
  ticket_runs: TicketRunView[] | "unknown";
  /** Per provider and window of `omp usage --json`. */
  provider_limits: ProviderWindow[] | "unknown";
  /** Median and p90 of step time by role, from closed runs. */
  role_times: RoleTimes;
};

/** One decision of a run, from `events.ndjson`: `why` is a plain sentence made from the event payload. */
export type TimelineEntry = {
  time: string;
  type: string;
  why: string;
  /** Test counts of `test.completed`; null for every other type. */
  counts: { pass: number; fail: number; missing: number } | null;
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

/** What `GET /api/run/<run>` answers: any run, open or closed, read on request and never part of the snapshot. */
export type RunDetail = {
  view: RunView;
  closed: boolean;
  outcome: string | null;
  /** Time of `run.closed`, or null for an open run. */
  closed_at: string | null;
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
      args: string;
      status: "ok" | "error" | "unknown";
      /** The first line of the result, cut to 300 characters. A full result never leaves the worker. */
      result: string;
    };

/** One page of a transcript: at most 200 entries. `next` is the byte offset of the next page, or null at the end. */
export type TranscriptPage = { entries: TranscriptEntry[]; next: number | null; size: number };
