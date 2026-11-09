// What several pages compute from one snapshot. Pure: no hook, no clock but the `age` the caller passes.
import { attentionOf, known } from "./format.tsx";
import { gatePhases, isFinishedTicket } from "../../cli/lifecycle.ts";
import type {
  Agent,
  ProviderWindow,
  RunView,
  Snapshot,
  TicketRunView,
  TicketView,
} from "../types.ts";

export type Stuck = {
  run: RunView;
  /** Null for the run-level fallback: Orca never answered `worktree ps`, so only the run's last event is known. */
  agent: Agent | null;
  kind: "waiting" | "idle";
  /** `waiting on a prompt`, `idle N min`. */
  text: string;
  lastLine: string | null;
  step: string | null;
};

/**
 * Agents that stop a run: waiting on a prompt, or idle for 5 minutes (the readers decide). Before
 * Orca's agent list has answered once, the 30-minute check of the run stays as the fallback.
 */
export function stuckAgents(snapshot: Snapshot, age: (time: string) => number): Stuck[] {
  if (!known(snapshot.runs)) return [];
  const { ok, read_at } = snapshot.sources.agentWait;
  return snapshot.runs.flatMap((run): Stuck[] => {
    if (read_at !== null && known(run.agents)) {
      // Agent facts kept from the last good read stay (their activity shows its age). While the
      // source fails, a run they do not flag falls back to the run-level check below.
      const flagged = run.agents.flatMap((agent) =>
        agent.activity.kind === "waiting" || agent.activity.kind === "idle"
          ? [
              {
                run,
                agent,
                kind: agent.activity.kind,
                text: agent.activity.text,
                lastLine: agent.activity.last_line,
                step: agent.step,
              },
            ]
          : [],
      );
      if (ok || flagged.length > 0) return flagged;
    }
    return attentionOf(run, age)
      .filter((item) => item.kind === "idle")
      .map((item) => ({
        run,
        agent: null,
        kind: "idle",
        text: item.label,
        lastLine: null,
        step: item.step,
      }));
  });
}

/** Pages that ask the human: a run is in the Needs me lane while a gate or an unread question holds it. */
export function needsHuman(snapshot: Snapshot, run: RunView): boolean {
  const gated = known(snapshot.gates) && snapshot.gates.some((gate) => gate.run === run.run);
  return gated || run.waiting.length > 0 || gatePhases.includes(run.phase);
}

/** The window with the highest used fraction, or null when no provider answered. */
export function highestUsage(limits: ProviderWindow[] | "unknown"): ProviderWindow | null {
  if (!known(limits)) return null;
  let top: ProviderWindow | null = null;
  for (const limit of limits)
    if (limit.used_fraction !== null && limit.used_fraction > (top?.used_fraction ?? -1))
      top = limit;
  return top;
}

export const percent = (fraction: number) => Math.round(fraction * 100);
/** A window at or above 80% shows red with its reset time. */
export const nearLimit = (limit: ProviderWindow) => (limit.used_fraction ?? 0) >= 0.8;

/** `YYYY-MM-DD` of a date in local time: the date a run name starts with. */
export const dayOf = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * Cost by day of the newest run of each ticket plus every open run, from the date in the run name.
 * A run with unknown cost adds nothing: its day shows a lower bound, never a guess.
 */
export function costByDay(snapshot: Snapshot): Map<string, number> {
  const costs = new Map<string, number | null>();
  if (known(snapshot.ticket_runs))
    for (const entry of snapshot.ticket_runs) costs.set(entry.run, entry.cost_usd);
  if (known(snapshot.runs)) for (const run of snapshot.runs) costs.set(run.run, run.cost_usd);
  const days = new Map<string, number>();
  for (const [run, cost] of costs) {
    const day = run.slice(0, 10);
    if (cost !== null && /^\d{4}-\d\d-\d\d$/.test(day)) days.set(day, (days.get(day) ?? 0) + cost);
  }
  return days;
}

/** Newest-first closed runs of every ticket: names and phases of `ticket_runs[].all`, with the ticket. */
export function closedRuns(
  entries: TicketRunView[],
): { run: string; ticket: string; project: string }[] {
  return entries
    .flatMap((entry) =>
      entry.all
        .filter((candidate) => candidate.phase === "closed")
        .map((candidate) => ({ run: candidate.run, ticket: entry.ticket, project: entry.project })),
    )
    .toSorted((left, right) => right.run.localeCompare(left.run));
}

/** The ticket is no longer a blocker once it is done or replaced. */
export const isSatisfied = (ticket: TicketView | undefined) =>
  ticket !== undefined && isFinishedTicket(ticket.status);

/** `merge order`: the oldest MR waits longest and goes first. */
export function reviewQueue(runs: RunView[]): RunView[] {
  const waited = (run: RunView): number =>
    Math.min(
      ...run.merge_requests.map((request) => Date.parse(request.created_at ?? "") || Infinity),
      Infinity,
    );
  return runs
    .filter((run) => run.phase === "merge_requests_open")
    .toSorted((left, right) => waited(left) - waited(right) || left.run.localeCompare(right.run));
}

export type TicketEntry = {
  ticket: TicketView;
  key: string;
  /** The open run of the ticket, if any. */
  open: RunView | null;
  /** The newest run, open or closed. */
  newest: TicketRunView | null;
  /** One word: `needs me`, `building`, `planning`, `awaiting merge`, `closed`, `queued`, `blocked`, or the ticket status. */
  state: string;
  /** Phase class for color: `p-gate`, `p-build`, `p-review`, `p-done`, `p-plan`, `p-none`. */
  tone: string;
  /** The lane of the Runs board; `null` for a ticket that is on no lane (proposed, done without a closed run). */
  lane: "Queued" | "Building" | "Needs me" | "Awaiting merge" | "Closed" | null;
  satisfied: boolean;
};

export const ticketKey = (project: string, id: string) => `${project}/${id}`;

/** Every ticket with the state the Runs board, the graph and the ticket page show for it. */
export function ticketEntries(snapshot: Snapshot): Map<string, TicketEntry> {
  const entries = new Map<string, TicketEntry>();
  if (!known(snapshot.tickets)) return entries;
  const newest = new Map(
    (known(snapshot.ticket_runs) ? snapshot.ticket_runs : []).map((entry) => [
      ticketKey(entry.project, entry.ticket),
      entry,
    ]),
  );
  const open = new Map(
    (known(snapshot.runs) ? snapshot.runs : []).map((run) => [
      ticketKey(run.project, run.ticket.id),
      run,
    ]),
  );
  const byKey = new Map(
    snapshot.tickets.map((ticket) => [ticketKey(ticket.project, ticket.id), ticket]),
  );
  for (const ticket of snapshot.tickets) {
    const key = ticketKey(ticket.project, ticket.id);
    const run = open.get(key) ?? null;
    const last = newest.get(key) ?? null;
    const blocked = ticket.depends_on.some(
      (id) => !isSatisfied(byKey.get(ticketKey(ticket.project, id))),
    );
    let entry: Pick<TicketEntry, "state" | "tone" | "lane">;
    if (run && needsHuman(snapshot, run))
      entry = { state: "needs me", tone: "p-gate", lane: "Needs me" };
    else if (run?.phase === "merge_requests_open")
      entry = { state: "awaiting merge", tone: "p-review", lane: "Awaiting merge" };
    else if (run)
      entry = {
        state: run.phase === "planning" ? "planning" : "building",
        tone: run.phase === "planning" ? "p-plan" : "p-build",
        lane: "Building",
      };
    else if (last?.phase === "closed") entry = { state: "closed", tone: "p-done", lane: "Closed" };
    else if (ticket.status === "ready")
      entry = { state: blocked ? "blocked" : "queued", tone: "p-none", lane: "Queued" };
    else entry = { state: ticket.status.replaceAll("_", " "), tone: "p-none", lane: null };
    entries.set(key, {
      ticket,
      key,
      open: run,
      newest: last,
      ...entry,
      satisfied: isSatisfied(ticket),
    });
  }
  return entries;
}

/** Every project of the tickets, the runs and the gates that answered, in name order. */
export function projectsOf(snapshot: Snapshot): string[] {
  const names = new Set<string>();
  for (const list of [snapshot.tickets, snapshot.runs, snapshot.gates])
    if (known(list)) for (const item of list) names.add(item.project);
  return [...names].toSorted();
}

/** The filter names no project. Said only once the tickets, runs and gates all answered. */
export const isUnknownProject = (snapshot: Snapshot, project: string | null): boolean =>
  project !== null &&
  known(snapshot.tickets) &&
  known(snapshot.runs) &&
  known(snapshot.gates) &&
  !projectsOf(snapshot).includes(project);

/** The snapshot cut to one project (`null` is All projects). Every record carries its project. */
export function scoped(snapshot: Snapshot, project: string | null): Snapshot {
  if (project === null) return snapshot;
  const only = <T extends { project: string }>(list: T[] | "unknown") =>
    known(list) ? list.filter((item) => item.project === project) : list;
  return {
    ...snapshot,
    runs: only(snapshot.runs),
    gates: only(snapshot.gates),
    tickets: only(snapshot.tickets),
    ticket_runs: only(snapshot.ticket_runs),
    roadmap: known(snapshot.roadmap)
      ? Object.fromEntries(Object.entries(snapshot.roadmap).filter(([name]) => name === project))
      : snapshot.roadmap,
  };
}
