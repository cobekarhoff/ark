// test ids: map-node (data-ticket, data-phase), map-edge (data-from, data-to), map-finished
import { useEffect, useRef } from "react";
import { ArrowMarker, Unknown, known, phaseClass, phaseLabel } from "./format.tsx";
import { edgePath, layout } from "./layout.ts";
import { parseRoute, useHash, useLive } from "./store.tsx";

const nodeWidth = 120;
const nodeHeight = 48;
const gapX = 70;
const gapY = 20;
const pad = 10;

const legend = [
  ["p-plan", "planning"],
  ["p-build", "building"],
  ["p-review", "merge requests open"],
  ["p-gate", "waiting for you"],
  ["p-done", "closed"],
  ["p-none", "no run"],
] as const;

export function MapView() {
  const { snapshot } = useLive();
  const finished = parseRoute(useHash()).arg === "finished";
  const box = useRef<HTMLDivElement>(null);
  const tickets = snapshot && known(snapshot.tickets) ? snapshot.tickets : [];
  const runs = snapshot && known(snapshot.ticket_runs) ? snapshot.ticket_runs : [];
  // Ticket IDs are unique inside a project: an edge stays inside its project.
  const key = (project: string, id: string) => `${project}/${id}`;
  const newest = new globalThis.Map(runs.map((run) => [key(run.project, run.ticket), run]));
  const isLive = (id: string) => {
    const run = newest.get(id);
    return run !== undefined && run.phase !== "closed";
  };
  // Default: the tickets whose newest run is not closed, and the tickets next to them.
  const live = new Set(tickets.map((ticket) => key(ticket.project, ticket.id)).filter(isLive));
  const near = new Set(live);
  for (const ticket of tickets) {
    const id = key(ticket.project, ticket.id);
    for (const need of ticket.depends_on) {
      const needId = key(ticket.project, need);
      if (live.has(id)) near.add(needId);
      if (live.has(needId)) near.add(id);
    }
  }
  const sorted = tickets
    .filter((ticket) => finished || near.has(key(ticket.project, ticket.id)))
    .toSorted(
      (left, right) =>
        Number(live.has(key(right.project, right.id))) -
          Number(live.has(key(left.project, left.id))) ||
        key(left.project, left.id).localeCompare(key(right.project, right.id)),
    );
  const { placed, edges } = layout(
    sorted.map((ticket) => ({
      id: key(ticket.project, ticket.id),
      needs: ticket.depends_on.map((id) => key(ticket.project, id)),
    })),
  );
  const at = new globalThis.Map(
    placed.map(({ id, col, row }) => [
      id,
      { x: pad + col * (nodeWidth + gapX), y: pad + row * (nodeHeight + gapY) },
    ]),
  );
  const width = Math.max(...placed.map((p) => p.col), 0) * (nodeWidth + gapX) + nodeWidth + 2 * pad;
  const height =
    Math.max(...placed.map((p) => p.row), 0) * (nodeHeight + gapY) + nodeHeight + 2 * pad;
  const byKey = new globalThis.Map(
    sorted.map((ticket) => [key(ticket.project, ticket.id), ticket]),
  );
  // Open on live work: the first live node, not the first column.
  const focus = sorted.find((ticket) => live.has(key(ticket.project, ticket.id)));
  const focusX = focus ? at.get(key(focus.project, focus.id))!.x : 0;
  useEffect(() => {
    if (box.current)
      box.current.scrollLeft = Math.max(0, focusX + nodeWidth / 2 - box.current.clientWidth / 2);
  }, [focusX, finished]);
  if (!snapshot || !known(snapshot.tickets) || !known(snapshot.ticket_runs))
    return (
      <>
        <h1>Map</h1>
        <Unknown />
      </>
    );
  return (
    <>
      <h1>Map: tickets by newest run phase</h1>
      <div className="toolbar">
        <button
          type="button"
          className="toggle"
          data-testid="map-finished"
          aria-pressed={finished}
          onClick={() => (location.hash = finished ? "#/map" : "#/map/finished")}
        >
          Show finished
        </button>
        <span className="mut">
          {finished
            ? `all ${tickets.length} tickets`
            : `${sorted.length} of ${tickets.length} tickets: open work and its neighbours`}
        </span>
      </div>
      <p className="mut legend">
        {legend.map(([className, label]) => (
          <span key={className} className={className}>
            <span className="dot" />
            <span className="mut">{label}</span>
          </span>
        ))}
      </p>
      {sorted.length === 0 ? (
        <p className="mut">No open work. Show finished lists every ticket.</p>
      ) : (
        <div
          ref={box}
          className="graph"
          tabIndex={0}
          role="region"
          aria-label="Ticket graph, scrollable"
        >
          <svg role="group" aria-label="Ticket dependency graph" width={width} height={height}>
            <ArrowMarker id="arrow-map" />
            {edges.map(({ from, to }) => {
              const start = at.get(from)!;
              const end = at.get(to)!;
              return (
                <path
                  key={`${from}>${to}`}
                  className="edge"
                  data-testid="map-edge"
                  data-from={byKey.get(from)!.id}
                  data-to={byKey.get(to)!.id}
                  markerEnd="url(#arrow-map)"
                  d={edgePath(
                    start.x + nodeWidth,
                    start.y + nodeHeight / 2,
                    end.x,
                    end.y + nodeHeight / 2,
                  )}
                />
              );
            })}
            {sorted.map((ticket) => {
              const id = key(ticket.project, ticket.id);
              const { x, y } = at.get(id)!;
              const run = newest.get(id);
              const phase = run?.phase ?? null;
              const href = run
                ? `#/run/${encodeURIComponent(run.run)}`
                : `#/backlog/${encodeURIComponent(ticket.id)}`;
              return (
                <g
                  key={id}
                  className={run?.waiting ? "p-gate" : phaseClass(phase)}
                  data-testid="map-node"
                  data-ticket={ticket.id}
                  data-phase={phase ?? "no run"}
                >
                  <a href={href}>
                    <title>{`${ticket.id} ${ticket.title ?? ""}: ${run?.waiting ? "waiting" : (phase ?? "no run")}`}</title>
                    <rect
                      className="tbox"
                      x={x}
                      y={y}
                      width={nodeWidth}
                      height={nodeHeight}
                      rx={7}
                    />
                    <text className="tid m" x={x + 12} y={y + 20}>
                      {ticket.id}
                    </text>
                    <text className="tphase" x={x + 12} y={y + 37}>
                      {run?.waiting ? "waiting" : phase === null ? "no run" : phaseLabel(phase)}
                    </text>
                  </a>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <p className="mut">
        {sorted.length} {sorted.length === 1 ? "ticket" : "tickets"} · {edges.length}{" "}
        {edges.length === 1 ? "edge" : "edges"} · no step nodes
      </p>
    </>
  );
}
