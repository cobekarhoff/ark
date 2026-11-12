// What several pages compute from one snapshot. Pure: no hook, no clock but the `age` the caller passes.
import { attentionOf, known, phaseClass } from "./format.tsx";
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

/**
 * The states the hub derives for a ticket, each with its lane of the Runs board. `ticketEntries`
 * picks the first that holds: needs me, awaiting merge, planning or building (an open run), closed
 * (the newest run), then blocked, approved not queued or queued (a ready ticket). `queued` means
 * the Orca queue holds the ticket's Task (or cannot be read, so nothing is claimed either way).
 * A ticket in none of them shows its own status and sits on no lane.
 */
export const ticketLanes = {
  "needs me": "Needs me",
  "awaiting merge": "Awaiting merge",
  planning: "Building",
  building: "Building",
  closed: "Closed",
  blocked: "Queued",
  "approved, not queued": "Queued",
  queued: "Queued",
} as const;
export type TicketState = keyof typeof ticketLanes;
export type Lane = (typeof ticketLanes)[TicketState];

export type TicketEntry = {
  ticket: TicketView;
  key: string;
  open: RunView | null;
  newest: TicketRunView | null;
  /** A `TicketState`, or the ticket status with spaces for a ticket in none. */
  state: string;
  /** Phase class for color: `p-gate`, `p-build`, `p-review`, `p-done`, `p-plan`, `p-none`. */
  tone: string;
  lane: Lane | null;
  satisfied: boolean;
};

/** How the newest run of a closed ticket ended; `undefined` while the ticket is not closed. */
export const outcomeOf = (entry: TicketEntry): string | null | undefined =>
  entry.lane === "Closed" ? (entry.newest?.all[0]?.outcome ?? null) : undefined;

function ticketState(
  snapshot: Snapshot,
  run: RunView | null,
  newest: TicketRunView | null,
  status: string,
  blocked: boolean,
  inQueue: boolean | null,
): TicketState | null {
  if (run && needsHuman(snapshot, run)) return "needs me";
  if (run)
    return run.phase === "merge_requests_open"
      ? "awaiting merge"
      : run.phase === "planning"
        ? "planning"
        : "building";
  if (newest?.phase === "closed") return "closed";
  if (status === "ready")
    return blocked ? "blocked" : inQueue === false ? "approved, not queued" : "queued";
  return null;
}

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
  const queues = new Map(
    (known(snapshot.queues) ? snapshot.queues : []).map((queue) => [queue.project, queue]),
  );
  for (const ticket of snapshot.tickets) {
    const key = ticketKey(ticket.project, ticket.id);
    const run = open.get(key) ?? null;
    const last = newest.get(key) ?? null;
    const blocked = ticket.depends_on.some(
      (id) => !isFinishedTicket(byKey.get(ticketKey(ticket.project, id))?.status),
    );
    const queue = queues.get(ticket.project);
    // Unreadable or unknown queue: no claim, the old `queued` label stays.
    const inQueue =
      !queue || "unavailable" in queue
        ? null
        : queue.tasks.some((task) => task.ticket === ticket.id);
    const state = ticketState(snapshot, run, last, ticket.status, blocked, inQueue);
    const entry: Pick<TicketEntry, "state" | "tone" | "lane"> = {
      state: state ?? ticket.status.replaceAll("_", " "),
      tone:
        state === "needs me"
          ? "p-gate"
          : run
            ? phaseClass(run.phase)
            : state === "closed"
              ? "p-done"
              : "p-none",
      lane: state ? ticketLanes[state] : null,
    };
    entries.set(key, {
      ticket,
      key,
      open: run,
      newest: last,
      ...entry,
      satisfied: isFinishedTicket(ticket.status),
    });
  }
  return entries;
}

export type StartRow = {
  ticket: string;
  title: string | null;
  status: "ready" | "pending";
  /** `starts next`, `starts when a run closes (<open>/<limit> open)` or `waits on <ticket ids>`. */
  reason: string;
};
/** One project's block on Home: its queue rows and its approved tickets no Task holds, or why the queue is unreadable. */
export type StartsNext = { project: string; open: number; limit: number | null } & (
  | { unavailable: string }
  | { rows: StartRow[]; notQueued: TicketView[] }
);

/**
 * Master Chief's queue by project. A Task whose ticket has an open run, or whose title names no
 * ticket, does not show. Order: ready before pending, each by roadmap rank, then ticket id; a
 * ticket the roadmap does not rank comes after the ranked ones. A ready ticket with no Task and no
 * open run is `notQueued` (a Task in any other status is not in the queue, so it counts as none).
 */
export function startsNext(snapshot: Snapshot): StartsNext[] {
  if (!known(snapshot.queues)) return [];
  const tickets = known(snapshot.tickets) ? snapshot.tickets : [];
  const openKeys = new Set(
    (known(snapshot.runs) ? snapshot.runs : []).map((run) => ticketKey(run.project, run.ticket.id)),
  );
  return snapshot.queues.map((queue): StartsNext => {
    const head = { project: queue.project, open: queue.open };
    if ("unavailable" in queue) return { ...head, limit: null, unavailable: queue.unavailable };
    const mine = tickets.filter((ticket) => ticket.project === queue.project);
    const byId = new Map(mine.map((ticket) => [ticket.id, ticket]));
    const roadmap = known(snapshot.roadmap) ? snapshot.roadmap[queue.project] : undefined;
    const ranked =
      roadmap && "now" in roadmap ? [...roadmap.now, ...roadmap.next, ...roadmap.later] : [];
    const rank = (id: string) => {
      const at = ranked.findIndex((item) => item.id === id);
      return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    };
    const rows = queue.tasks
      .filter(
        (task) => task.ticket !== null && !openKeys.has(ticketKey(queue.project, task.ticket)),
      )
      .map((task): StartRow => {
        const id = task.ticket!;
        const waitsOn = (byId.get(id)?.depends_on ?? []).filter(
          (dependency) => !isFinishedTicket(byId.get(dependency)?.status),
        );
        const reason =
          task.status === "pending"
            ? `waits on ${waitsOn.length > 0 ? waitsOn.join(", ") : "its dependencies"}`
            : queue.concurrency === null
              ? "limit unknown"
              : queue.open < queue.concurrency
                ? "starts next"
                : `starts when a run closes (${queue.open}/${queue.concurrency} open)`;
        return { ticket: id, title: byId.get(id)?.title ?? null, status: task.status, reason };
      })
      .toSorted(
        (a, b) =>
          Number(a.status === "pending") - Number(b.status === "pending") ||
          rank(a.ticket) - rank(b.ticket) ||
          a.ticket.localeCompare(b.ticket, undefined, { numeric: true }),
      );
    const queued = new Set(queue.tasks.map((task) => task.ticket));
    const notQueued = mine
      .filter(
        (ticket) =>
          ticket.status === "ready" &&
          !queued.has(ticket.id) &&
          !openKeys.has(ticketKey(ticket.project, ticket.id)),
      )
      .toSorted(
        (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id, undefined, { numeric: true }),
      );
    return { ...head, limit: queue.concurrency, rows, notQueued };
  });
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
    queues: only(snapshot.queues),
    roadmap: known(snapshot.roadmap)
      ? Object.fromEntries(Object.entries(snapshot.roadmap).filter(([name]) => name === project))
      : snapshot.roadmap,
  };
}
