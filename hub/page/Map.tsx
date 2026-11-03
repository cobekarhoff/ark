// test ids: map-node (data-ticket, data-phase), map-edge (data-from, data-to)
import { Unknown, known, phaseClass } from "./format.tsx";
import { edgePath, layout } from "./layout.ts";
import { useLive } from "./store.tsx";

const nodeWidth = 120;
const nodeHeight = 44;
const gapX = 70;
const gapY = 24;
const pad = 10;

const legend = [
  ["p-plan", "planning"],
  ["p-build", "building"],
  ["p-review", "merge_requests_open"],
  ["p-gate", "waiting for the human"],
  ["p-done", "closed"],
  ["p-none", "no run"],
] as const;

export function MapView() {
  const { snapshot } = useLive();
  if (!snapshot || !known(snapshot.tickets) || !known(snapshot.ticket_runs))
    return (
      <>
        <h1>Map</h1>
        <Unknown />
      </>
    );
  const { tickets, ticket_runs: runs } = snapshot;
  const phaseOf = new globalThis.Map(
    runs.map((run) => [`${run.project}/${run.ticket}`, run.phase]),
  );
  // Ticket IDs are unique inside a project: an edge stays inside its project.
  const key = (project: string, id: string) => `${project}/${id}`;
  const sorted = [...tickets].sort((a, b) =>
    key(a.project, a.id).localeCompare(key(b.project, b.id)),
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
  return (
    <>
      <h1>Map: tickets by newest run phase</h1>
      <p className="mut legend">
        {legend.map(([className, label]) => (
          <span key={className} className={className}>
            <span className="dot" />
            <span className="mut">{label}</span>
          </span>
        ))}
      </p>
      <div className="graph" tabIndex={0} role="region" aria-label="Ticket graph, scrollable">
        <svg role="group" aria-label="Ticket dependency graph" width={width} height={height}>
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
            const phase = phaseOf.get(id) ?? null;
            return (
              <g
                key={id}
                className={phaseClass(phase)}
                data-testid="map-node"
                data-ticket={ticket.id}
                data-phase={phase ?? "no run"}
              >
                <title>{`${ticket.id} ${ticket.title ?? ""}: ${phase ?? "no run"}`}</title>
                <rect className="tbox" x={x} y={y} width={nodeWidth} height={nodeHeight} rx={7} />
                <text className="tid m" x={x + 12} y={y + nodeHeight / 2 + 5}>
                  {ticket.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mut">
        {tickets.length} tickets · {edges.length} edges · no step nodes
      </p>
    </>
  );
}
