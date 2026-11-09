import { layoutGraph, roundedPath, type GraphInput } from "./roadmap-graph.ts";
import { StatusChip, type RoadmapData, entryOf } from "./RoadmapParts.tsx";
import { ticketHref } from "./store.tsx";
import type { RoadmapMilestone } from "../roadmap.ts";
import { isFinishedTicket } from "../../cli/lifecycle.ts";

const marker = (name: string, className: string) => (
  <marker
    id={`rm-arrow-${name}`}
    viewBox="0 0 8 8"
    refX="7.5"
    refY="4"
    markerWidth="8"
    markerHeight="8"
    markerUnits="userSpaceOnUse"
    orient="auto"
  >
    <path d="M0,0 L8,4 L0,8 z" className={className} />
  </marker>
);

/** `ARK-156` reads `156` in the strip; the full id is in the title. */
const shortId = (id: string) => id.match(/\d+$/)?.[0] ?? id;

/**
 * Every open ticket in one lane per milestone, in roadmap order. A finished dependency is a dot in
 * the narrow done strip. An edge from a ticket that is not finished is dashed.
 */
export function RoadmapGraph({
  tickets,
  milestones,
  data,
  cursor,
  onOpen,
}: {
  tickets: { id: string; milestone: string | null }[];
  milestones: RoadmapMilestone[];
  data: RoadmapData;
  cursor: string | null;
  onOpen: (id: string) => void;
}) {
  const shown = new Set(tickets.map((ticket) => ticket.id));
  const laneOf = (milestone: string | null) => milestone ?? "";
  const used = new Set(tickets.map((ticket) => laneOf(ticket.milestone)));
  // Roadmap order first, then milestones the roadmap does not list.
  const lanes = [...new Set([...milestones.map((milestone) => milestone.id), ...used])].filter(
    (id) => used.has(id),
  );
  const input: GraphInput = {
    lanes,
    nodes: tickets.map((ticket) => {
      const needs = data.byId.get(ticket.id)?.depends_on ?? [];
      const dependency = (id: string) => data.byId.get(id);
      return {
        id: ticket.id,
        lane: laneOf(ticket.milestone),
        needs: needs.filter((id) => shown.has(id)),
        finishedNeeds: needs.filter((id) => isFinishedTicket(dependency(id)?.status)),
      };
    }),
  };
  const graph = layoutGraph(input);
  const nameOf = (id: string) =>
    milestones.find((milestone) => milestone.id === id) ?? {
      id,
      name: id === "" ? "No milestone" : id,
      state: "",
    };
  const boxOf = new Map(graph.nodes.map((entry) => [entry.id, entry.box]));
  return (
    <div className="rm-graph-scroll">
      <div
        className="rm-graph"
        style={{ width: graph.width, height: graph.height }}
        role="group"
        aria-label="Open tickets by milestone"
        data-testid="roadmap-graph"
      >
        {graph.strip ? (
          <div
            className="rm-lane strip"
            style={{ left: graph.strip.x, width: graph.strip.width, height: graph.strip.height }}
            data-testid="graph-strip"
          >
            <div className="rm-lane-head">
              <b>done</b>
              <span>{graph.dots.length} deps</span>
            </div>
          </div>
        ) : null}
        {graph.lanes.map((lane) => {
          const milestone = nameOf(lane.id);
          return (
            <div
              key={lane.id}
              className={`rm-lane${"state" in milestone && milestone.state === "active" ? " active" : ""}`}
              style={{ left: lane.box.x, width: lane.box.width, height: lane.box.height }}
              data-testid="graph-lane"
              data-milestone={lane.id}
            >
              <div className="rm-lane-head">
                <span className="rm-lane-id mono">
                  {lane.id === "" ? "–" : lane.id}
                  {"state" in milestone && milestone.state !== "" ? (
                    <span className={`rm-chip ${milestone.state === "active" ? "blue" : "none"}`}>
                      {milestone.state}
                    </span>
                  ) : null}
                </span>
                <span className="rm-lane-name">{milestone.name}</span>
              </div>
            </div>
          );
        })}
        <svg className="rm-edges" width={graph.width} height={graph.height} aria-hidden="true">
          <defs>
            {marker("finished", "rm-arrow finished")}
            {marker("open", "rm-arrow open")}
          </defs>
          {graph.edges.map((edge) => (
            <path
              key={`${edge.from}>${edge.to}`}
              className={edge.finished ? "rm-edge finished" : "rm-edge open"}
              data-testid="graph-edge"
              data-from={edge.from}
              data-to={edge.to}
              data-blocking={!edge.finished}
              markerEnd={`url(#rm-arrow-${edge.finished ? "finished" : "open"})`}
              d={roundedPath(edge.points)}
            />
          ))}
        </svg>
        {graph.dots.map((dot) => (
          <span
            key={dot.id}
            className="rm-dot"
            style={{ left: dot.x - 40, top: dot.y - 6, width: 40 + 3.5 }}
            data-testid="graph-dot"
            data-ticket={dot.id}
            title={dot.id}
          >
            {shortId(dot.id)}
            <i />
          </span>
        ))}
        {graph.nodes.map(({ id }) => {
          const box = boxOf.get(id)!;
          const entry = entryOf(data, id);
          return (
            <a
              key={id}
              href={ticketHref(id)}
              className={`rm-node${entry.ticket.status === "proposed" ? " proposed" : ""}`}
              style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              data-testid="graph-node"
              data-ticket={id}
              data-state={entry.state}
              aria-current={cursor === id ? "true" : undefined}
              title={`${id} ${entry.ticket.title ?? ""}`}
              onClick={() => onOpen(id)}
            >
              <span className="rm-node-top">
                <b className="mono">{id}</b>
                <StatusChip entry={entry} />
              </span>
              <span className="rm-node-title">{entry.ticket.title ?? id}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
