/**
 * Every lifecycle word Ark writes or reads, in one place. The CLI owns them and the hub page
 * imports them, so this file has no imports: it must bundle for the browser.
 */

export const phases = [
  "awaiting_criteria",
  "awaiting_strategy",
  "planning",
  "building",
  "escalation",
  "merge_requests_open",
  "closed",
] as const;
export type Phase = (typeof phases)[number];

/** The run waits for the human's answer. The plan gate is `planning` with a valid plan: see `waitingGate`. */
export const gatePhases: readonly Phase[] = [
  "awaiting_criteria",
  "awaiting_strategy",
  "escalation",
];
/** Steps start and finish, tests run and MRs open in these phases. */
export const buildPhases: readonly Phase[] = ["building", "escalation", "merge_requests_open"];
/** Every phase but `closed`: no event follows a run's close. */
const openPhases: readonly Phase[] = phases.filter((phase) => phase !== "closed");

/** How a closed run ended. `run.closed` sets it, and so does an `abort` answer at any gate. */
export const outcomes = ["merged", "abandoned", "aborted", "handed_off"] as const;
export type Outcome = (typeof outcomes)[number];

/** `config.ts` lets a project hand the first four to auto; the manual gate is always the human's. */
export const gates = ["criteria", "strategy", "plan", "escalation", "manual"] as const;
export type Gate = (typeof gates)[number];
/** The gates a phase waits on; the manual gate waits per criterion, inside `building`. */
export type PhaseGate = Exclude<Gate, "manual">;

/** The fixed answers of each gate. The strategy gate takes a card id of the latest `strategy.recorded`, or `abort`. */
export const gateAnswers: Record<Exclude<Gate, "strategy">, readonly string[]> = {
  criteria: ["accept", "edit", "abort"],
  plan: ["approve", "change", "abort"],
  escalation: ["one_more_round", "take_over", "abort"],
  manual: ["ok", "problem"],
};

/**
 * The phases a gate takes an answer in; the first is the phase the gate opens in. An escalation
 * answer in `building` is auto's only (a step start found the round budget spent), and in
 * `merge_requests_open` it allows the next MR round.
 */
export const gateAnswerPhases: Record<Gate, readonly Phase[]> = {
  criteria: ["awaiting_criteria"],
  strategy: ["awaiting_strategy"],
  plan: ["planning"],
  escalation: ["escalation", "merge_requests_open", "building"],
  manual: ["building", "escalation"],
};

/**
 * The transition table: each event type and the phases it is allowed in. `run.started` is only the
 * first event, and nothing follows `closed`. `transitions.ts` adds each event's own rules, and
 * `deriveState` in `events.ts` folds the events into the next phase.
 */
export const eventPhases = {
  "run.started": [],
  "criteria.updated": ["awaiting_criteria"],
  // In awaiting_criteria the ticket file is the source: the criteria gate takes the edit.
  "criteria.amended": ["awaiting_strategy", "planning", "building", "escalation"],
  "evaluation.recorded": ["awaiting_criteria", "planning"],
  "strategy.recorded": ["planning", "awaiting_strategy"],
  "plan.checked": ["planning", "building", "escalation"],
  // Each gate narrows this with gateAnswerPhases.
  "gate.answered": openPhases,
  "worktree.created": openPhases,
  "worktree.synced": ["planning", ...buildPhases],
  "step.started": buildPhases,
  "step.finished": buildPhases,
  "escalation.requested": ["building"],
  "test.completed": buildPhases,
  "merge_request.opened": ["building", "merge_requests_open"],
  "bump.refreshed": buildPhases,
  "run.closed": openPhases,
} satisfies Record<string, readonly Phase[]>;
export type EventType = keyof typeof eventPhases;

/**
 * The escalation gate inside a run: `requested` by `ark escalate` until an answer, then `answered`
 * until the round it granted starts (an implementer start after MRs opened; before them the next
 * test or the first MR), then `none` again.
 */
export type EscalationState = "none" | "requested" | "answered";

/** `pending` until `step.started`, then `running` until `step.finished` records `succeeded` or `failed`. `stopped` is never recorded: a closed run shows a step it left running as stopped. */
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "stopped";

export type CriterionStatus =
  | "pending"
  | "passing"
  | "failing"
  | "missing"
  | "not run"
  | "manual pending"
  | "manual ok"
  | "manual problem";

/** The criterion status a manual gate answer shows in `ark test`; no answer yet is `manual pending`. */
export function manualStatus(answer: string | undefined): CriterionStatus {
  return answer === "ok" ? "manual ok" : answer === "problem" ? "manual problem" : "manual pending";
}

export const ticketKinds = ["bug", "perf", "refactor", "feature"] as const;
export type TicketKind = (typeof ticketKinds)[number];

/** The `status:` of a local ticket file. The hub shows any other word as written. */
export const ticketStatuses = ["proposed", "ready", "in_progress", "done", "superseded"] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

/** A finished ticket no longer blocks the tickets that depend on it; an unknown ticket still blocks. */
export const isFinishedTicket = (status: string | undefined): boolean =>
  status === "done" || status === "superseded";

/** The ticket status a closed run leaves behind; `handed_off` leaves the file as it is. */
export function ticketStatusAfter(outcome: string): TicketStatus | undefined {
  if (outcome === "merged") return "done";
  if (outcome === "aborted" || outcome === "abandoned") return "ready";
  return undefined;
}
