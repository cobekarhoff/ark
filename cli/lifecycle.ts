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

export const outcomes: readonly string[] = ["merged", "abandoned", "aborted", "handed_off"];

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "stopped";

export type CriterionStatus =
  | "pending"
  | "passing"
  | "failing"
  | "missing"
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

/** A finished ticket no longer blocks the tickets that depend on it. */
export const isFinishedTicket = (status: string): boolean =>
  status === "done" || status === "superseded";

/** The ticket status a closed run leaves behind; `handed_off` leaves the file as it is. */
export function ticketStatusAfter(outcome: string): TicketStatus | undefined {
  if (outcome === "merged") return "done";
  if (outcome === "aborted" || outcome === "abandoned") return "ready";
  return undefined;
}
