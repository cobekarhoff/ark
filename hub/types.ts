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

export type SourceName = "ark" | "orca" | "plannotator" | "github" | "usage";
export type SourceStatus = { ok: boolean; read_at: string | null };

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "stopped";

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
  /** Harness and model of that plan step: shown when Orca reports none, labelled when they differ. */
  planned: { harness: string; model: string } | null;
};

export type MergeRequestView = {
  repo: string;
  url: string;
  number: number;
  state: "open" | "merged" | "closed";
  ci: "passing" | "failing" | "pending" | "unknown";
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
};

export type Snapshot = {
  generated_at: string;
  sources: Record<SourceName, SourceStatus>;
  /** Open runs only: Orca never removes runs, so closed ones stay out of the page. */
  runs: RunView[] | "unknown";
  gates: Gate[] | "unknown";
  tickets: TicketView[] | "unknown";
  ticket_runs: TicketRunView[] | "unknown";
};
