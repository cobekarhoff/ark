import { useState, type ReactNode } from "react";
import { DepGraph, type GraphTicket } from "./DepGraph.tsx";
import {
  isUnknownProject,
  scoped,
  ticketEntries,
  ticketKey,
  type Lane,
  type TicketEntry,
} from "./derive.ts";
import { Ring, Unknown, UnknownProject, dollars, known } from "./format.tsx";
import { runHref } from "./RunDetail.tsx";
import { ticketHref, useLive, useProject } from "./store.tsx";
import type { RunView, Snapshot, TicketRunView } from "../types.ts";

/** Newest-first closed runs of every ticket: names and phases of `ticket_runs[].all`, with the ticket. */
function closedRuns(entries: TicketRunView[]): {
  run: string;
  ticket: string;
  project: string;
  outcome: string | null;
  cost_usd: number | null;
}[] {
  return entries
    .flatMap((entry) =>
      entry.all
        .filter((candidate) => candidate.phase === "closed")
        .map((candidate) => ({
          run: candidate.run,
          ticket: entry.ticket,
          project: entry.project,
          outcome: candidate.outcome,
          cost_usd: candidate.cost_usd,
        })),
    )
    .toSorted((left, right) => right.run.localeCompare(left.run));
}

const lanes = [
  ["Queued", "waiting for a slot", "p-none"],
  ["Building", "agents working", "p-build"],
  ["Needs me", "gate or escalation", "p-gate"],
  ["Awaiting merge", "MR in the review queue", "p-review"],
  ["Closed", "newest first", "p-done"],
] as const satisfies readonly (readonly [Lane, string, string])[];

const closedPage = 20;
const filters = ["Active", "Queued", "Old"] as const;
type Filter = (typeof filters)[number];

const ringOf = (entry: TicketEntry): GraphTicket["ring"] =>
  entry.open?.progress
    ? { done: entry.open.progress.steps_done, total: entry.open.progress.steps_total }
    : entry.open
      ? { done: 0, total: 1, label: "–" }
      : entry.lane === "Closed"
        ? { done: 1, total: 1, label: "✓" }
        : { done: 0, total: 1, label: "–" };

const hrefOf = (entry: TicketEntry) =>
  entry.open
    ? runHref(entry.open.run)
    : entry.newest
      ? runHref(entry.newest.run)
      : ticketHref(entry.ticket.id);

/** The ticket-level state of a ticket in its card: `waits on ARK-282 (building)` for a blocked one. */
function waitsOn(entry: TicketEntry, entries: Map<string, TicketEntry>): string {
  const blockers = entry.ticket.depends_on
    .map((id) => entries.get(ticketKey(entry.ticket.project, id)))
    .filter((blocker): blocker is TicketEntry => blocker !== undefined && !blocker.satisfied);
  return blockers.length === 0
    ? "ready"
    : `waits on ${blockers.map((blocker) => `${blocker.ticket.id} (${blocker.state})`).join(", ")}`;
}

function Card({
  lane,
  run,
  ticket,
  title,
  ring,
  tone,
  href,
  note,
}: {
  lane: string;
  run: string | null;
  ticket: string;
  title: string;
  ring: GraphTicket["ring"];
  tone: string;
  href: string;
  note: ReactNode;
}) {
  return (
    <a
      className={`gnode card ${tone}`}
      href={href}
      data-testid="run-card"
      data-lane={lane}
      data-run={run ?? undefined}
      data-ticket={ticket}
    >
      <Ring {...ring} />
      <span className="gtext">
        <span className="ghead">
          <b className="mono">{ticket}</b>
          {run ? <span className="mut small">{run.slice(0, 10)}</span> : null}
        </span>
        <span className="title2">{title}</span>
        <span className="mut small">{note}</span>
      </span>
    </a>
  );
}

function noteOf(run: RunView): string {
  const progress = run.progress;
  const parts = [progress ? `round ${progress.round} of ${progress.round_budget}` : "no plan yet"];
  if (run.waiting[0]) parts.push("waiting for you");
  else if (run.merge_requests[0])
    parts.push(`MR #${run.merge_requests[0].number} · CI ${run.merge_requests[0].ci}`);
  return parts.join(" · ");
}

function Board({ snapshot, entries }: { snapshot: Snapshot; entries: Map<string, TicketEntry> }) {
  const [closedShown, setClosedShown] = useState(closedPage);
  const closed = known(snapshot.ticket_runs) ? closedRuns(snapshot.ticket_runs) : [];
  const byTicket = new Map([...entries.values()].map((entry) => [entry.ticket.id, entry]));
  const titleOf = (id: string) => byTicket.get(id)?.ticket.title ?? id;
  return (
    <div className="board">
      {lanes.map(([lane, hint, tone]) => {
        const cards = [...entries.values()].filter(
          (entry) => entry.lane === lane && lane !== "Closed",
        );
        const closedCards = lane === "Closed" ? closed.slice(0, closedShown) : [];
        const count = lane === "Closed" ? closed.length : cards.length;
        return (
          <section
            key={lane}
            className="lane"
            data-testid="lane"
            data-lane={lane}
            aria-label={lane}
          >
            <header>
              <h2>
                <i className={`dot ${tone}`} />
                {lane}
              </h2>
              <span className="count">{count}</span>
              <span className="hint">{hint}</span>
            </header>
            <div className="lane-body">
              {cards.map((entry) => (
                <Card
                  key={entry.key}
                  lane={lane}
                  run={entry.open?.run ?? null}
                  ticket={entry.ticket.id}
                  title={entry.open?.ticket.title ?? entry.ticket.title ?? entry.ticket.id}
                  ring={ringOf(entry)}
                  tone={tone}
                  href={hrefOf(entry)}
                  note={entry.open ? noteOf(entry.open) : waitsOn(entry, entries)}
                />
              ))}
              {closedCards.map((run) => (
                <Card
                  key={run.run}
                  lane={lane}
                  run={run.run}
                  ticket={run.ticket}
                  title={titleOf(run.ticket)}
                  ring={{ done: 1, total: 1, label: "✓" }}
                  tone={tone}
                  href={runHref(run.run)}
                  note={
                    <>
                      <span data-testid="card-outcome">{run.outcome ?? "unknown"}</span>
                      {" · "}
                      <span
                        data-testid="card-cost"
                        className={run.cost_usd === null ? "nr" : undefined}
                      >
                        {run.cost_usd === null ? "not recorded" : dollars.format(run.cost_usd)}
                      </span>
                    </>
                  }
                />
              ))}
              {count === 0 ? <p className="mut empty">None.</p> : null}
              {lane === "Closed" && closed.length > closedShown ? (
                <button
                  type="button"
                  className="btn"
                  data-testid="show-more"
                  onClick={() => setClosedShown(closedShown + closedPage)}
                >
                  Show more
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** The graph set of a filter: the tickets of its lanes, and for Active and Queued their open neighbours. */
function graphKeys(filter: Filter, entries: Map<string, TicketEntry>): Set<string> {
  const all = [...entries.values()];
  const primary = new Set(
    all
      .filter((entry) =>
        filter === "Active"
          ? entry.open !== null
          : filter === "Queued"
            ? entry.lane === "Queued"
            : entry.lane === "Closed",
      )
      .map((entry) => entry.key),
  );
  if (filter === "Old") return primary;
  const shown = new Set(primary);
  // A neighbour that is not done is still part of the picture: it blocks or waits.
  for (const entry of all)
    for (const id of entry.ticket.depends_on) {
      const need = ticketKey(entry.ticket.project, id);
      if (primary.has(entry.key) && entries.get(need) && !entries.get(need)!.satisfied)
        shown.add(need);
      if (primary.has(need) && !entry.satisfied) shown.add(entry.key);
    }
  return shown;
}

export function Runs() {
  const { snapshot: whole } = useLive();
  const project = useProject();
  const [filter, setFilter] = useState<Filter>("Active");
  if (!whole || !known(whole.tickets) || !known(whole.runs))
    return (
      <>
        <h1>Runs</h1>
        <Unknown />
      </>
    );
  if (isUnknownProject(whole, project))
    return (
      <>
        <h1>Runs</h1>
        <UnknownProject project={project!} />
      </>
    );
  const snapshot = scoped(whole, project);
  const entries = ticketEntries(snapshot);
  const counts: Record<Filter, number> = {
    Active: [...entries.values()].filter((entry) => entry.open !== null).length,
    Queued: [...entries.values()].filter((entry) => entry.lane === "Queued").length,
    Old: [...entries.values()].filter((entry) => entry.lane === "Closed").length,
  };
  const keys = graphKeys(filter, entries);
  const shown = [...entries.values()].filter((entry) => keys.has(entry.key));
  const graph: GraphTicket[] = shown.map((entry) => ({
    key: entry.key,
    id: entry.ticket.id,
    title: entry.open?.ticket.title ?? entry.ticket.title ?? entry.ticket.id,
    state: entry.state,
    tone: entry.tone,
    href: hrefOf(entry),
    ring: ringOf(entry),
    needs: entry.ticket.depends_on.map((id) => ticketKey(entry.ticket.project, id)),
    satisfied: entry.satisfied,
  }));
  const unblocks = [...entries.values()]
    .filter((entry) => entry.open !== null)
    .map((entry) => ({
      entry,
      next: [...entries.values()].filter(
        (other) =>
          !other.satisfied &&
          other.ticket.depends_on.includes(entry.ticket.id) &&
          other.ticket.project === entry.ticket.project,
      ),
    }));
  const open = known(snapshot.runs) ? snapshot.runs.length : 0;
  return (
    <>
      <h1>
        Runs <span className="filter-name">· {project ?? "All projects"}</span>{" "}
        <span className="mut sub">
          {open} open · {counts.Queued} queued · {counts.Old} closed. Click a run for its plan.
        </span>
      </h1>
      <Board snapshot={snapshot} entries={entries} />
      <section className="panel graph-panel">
        <header>
          <h2>Cross-run dependency graph</h2>
          <div className="seg" role="group" aria-label="Graph filter">
            {filters.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={filter === name}
                data-testid="graph-filter"
                data-filter={name}
                onClick={() => setFilter(name)}
              >
                {name} <span className="count">{counts[name]}</span>
              </button>
            ))}
          </div>
          <span className="hint legend">
            <span className="dash" /> still blocking <span className="solid" /> satisfied
          </span>
        </header>
        <div className="graph-split">
          <div
            className="graph-scroll"
            tabIndex={0}
            role="region"
            aria-label="Ticket graph, scrollable"
          >
            {graph.length === 0 ? (
              <p className="mut empty">No ticket in this filter.</p>
            ) : (
              <DepGraph tickets={graph} label={`Dependency graph, ${filter}`} />
            )}
          </div>
          <aside className="unblocks-list" aria-label="What finishing unblocks">
            <h3>What finishing unblocks</h3>
            {unblocks.length === 0 ? <p className="mut">No open run.</p> : null}
            {unblocks.map(({ entry, next }) => (
              <div key={entry.key} data-testid="unblocks" data-ticket={entry.ticket.id}>
                <a className="mono strong" href={hrefOf(entry)}>
                  {entry.ticket.id}
                </a>{" "}
                <span className="mut">{entry.state}</span>
                <div className="chips">
                  {next.length === 0 ? (
                    <span className="mut">unblocks nothing</span>
                  ) : (
                    next.map((other) => (
                      <a key={other.key} className="chip mono" href={ticketHref(other.ticket.id)}>
                        {other.ticket.id}
                      </a>
                    ))
                  )}
                </div>
              </div>
            ))}
          </aside>
        </div>
      </section>
    </>
  );
}
