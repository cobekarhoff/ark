import { ArrowMarker, Ring } from "./format.tsx";
import { edgePath, layout } from "./layout.ts";

export type GraphTicket = {
  /** Unique inside the graph. */
  key: string;
  /** The ticket id shown on the node. */
  id: string;
  title: string;
  /** `building`, `queued`, `closed`, ...: one word, also the `data-state` of the node. */
  state: string;
  /** Phase class for the dot and border (`p-build`, `p-gate`, ...). */
  tone: string;
  href: string;
  ring: { done: number; total: number; label?: string };
  /** Keys of the tickets this one depends on. */
  needs: string[];
  /** Done or superseded: an edge from it is solid, any other edge is dashed (still blocking). */
  satisfied: boolean;
};

const sizes = {
  wide: { width: 300, height: 66, gapX: 96, gapY: 14 },
  compact: { width: 176, height: 58, gapX: 44, gapY: 12 },
};
const pad = 10;

/**
 * Ticket cards in columns by longest dependency path, with an arrow from each dependency to its
 * dependent. The cards are HTML so their titles wrap to 2 lines and keep real text; the arrows are
 * one SVG behind them. An arrow from a ticket that is not done is dashed.
 */
export function DepGraph({
  tickets,
  label,
  size = "wide",
  focus,
}: {
  tickets: GraphTicket[];
  label: string;
  size?: keyof typeof sizes;
  focus?: string;
}) {
  const { width: cardWidth, height: cardHeight, gapX, gapY } = sizes[size];
  const { placed, edges } = layout(tickets.map(({ key, needs }) => ({ id: key, needs })));
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const at = new Map(
    placed.map(({ id, col, row }) => [
      id,
      { x: pad + col * (cardWidth + gapX), y: pad + row * (cardHeight + gapY) },
    ]),
  );
  const width =
    Math.max(...placed.map((spot) => spot.col), 0) * (cardWidth + gapX) + cardWidth + 2 * pad;
  const height =
    Math.max(...placed.map((spot) => spot.row), 0) * (cardHeight + gapY) + cardHeight + 2 * pad;
  return (
    <div className="depgraph" style={{ width, height }} role="group" aria-label={label}>
      <svg width={width} height={height} aria-hidden="true">
        <ArrowMarker id={`arrow-${size}`} />
        {edges.map(({ from, to }) => {
          const start = at.get(from)!;
          const end = at.get(to)!;
          const blocking = !byKey.get(from)!.satisfied;
          return (
            <path
              key={`${from}>${to}`}
              className={blocking ? "gedge blocking" : "gedge"}
              data-testid="graph-edge"
              data-from={byKey.get(from)!.id}
              data-to={byKey.get(to)!.id}
              data-blocking={blocking}
              markerEnd={`url(#arrow-${size})`}
              d={edgePath(
                start.x + cardWidth,
                start.y + cardHeight / 2,
                end.x,
                end.y + cardHeight / 2,
              )}
            />
          );
        })}
      </svg>
      {tickets.map((ticket) => {
        const { x, y } = at.get(ticket.key)!;
        return (
          <a
            key={ticket.key}
            href={ticket.href}
            className={`gnode ${ticket.tone}${ticket.key === focus ? " focus" : ""}`}
            style={{ left: x, top: y, width: cardWidth, height: cardHeight }}
            data-testid="graph-node"
            data-ticket={ticket.id}
            data-state={ticket.state}
            title={`${ticket.id} ${ticket.title}`}
          >
            <Ring {...ticket.ring} />
            <span className="gtext">
              <span className="ghead">
                <b className="mono">{ticket.id}</b>
                <span className="mut small">{ticket.state}</span>
              </span>
              <span className="title2">{ticket.title}</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}
