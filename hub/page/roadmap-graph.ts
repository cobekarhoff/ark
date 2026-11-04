import { layout } from "./layout.ts";

/**
 * Lane layout of the Roadmap graph: one lane per milestone, nodes on a row grid shared by every
 * lane, and a "done" strip of dots for finished dependencies. Edges are orthogonal and routed only
 * through places no node occupies:
 * - a vertical run goes in the gutter beside a lane's nodes (each edge has its own slot),
 * - a horizontal run goes in the channel above the row of the target (each edge has its own sub-lane).
 * A node box is never entered, so no edge crosses a node it does not join. `crossings` checks this.
 */
export type GraphInput = {
  /** Lane ids in order. */
  lanes: string[];
  nodes: { id: string; lane: string; needs: string[]; finishedNeeds: string[] }[];
};

export type Box = { x: number; y: number; width: number; height: number };
type Point = [number, number];

export type GraphLayout = {
  width: number;
  height: number;
  strip: Box | null;
  lanes: { id: string; box: Box }[];
  nodes: { id: string; lane: string; box: Box }[];
  /** One dot per finished dependency; `x`, `y` are its centre. */
  dots: { id: string; x: number; y: number }[];
  /** `from` is the dependency, `to` the ticket that needs it. `finished`: the dependency is a dot. */
  edges: { from: string; to: string; finished: boolean; points: Point[] }[];
};

export const node = { width: 176, height: 88 };
const header = 58;
const lanePadding = 12;
const laneGap = 8;
const stepX = 6;
const stepY = 12;
const gutterBase = 10;
const stripMain = 44;
const dotRadius = 3.5;

type Side = "left" | "right";
type Route = {
  from: string;
  to: string;
  finished: boolean;
  /** Lane of the source: `strip` for a dot. */
  sourceLane: string;
  targetLane: string;
  targetRow: number;
  sourceSide: Side;
  targetSide: Side;
  sourceSlot: number;
  targetSlot: number;
  /** Sub-lane in the channel above the target row; null for an edge inside one lane. */
  channel: number | null;
};

const strip = "strip";

export function layoutGraph(input: GraphInput): GraphLayout {
  const laneIndex = new Map(input.lanes.map((id, index) => [id, index]));
  const ids = new Set(input.nodes.map((entry) => entry.id));
  const known = input.nodes.filter((entry) => laneIndex.has(entry.lane));

  // Rows: dependency depth (layout.ts), pushed down so one lane never puts two nodes on a row.
  const { placed } = layout(
    known.map((entry) => ({ id: entry.id, needs: entry.needs.filter((need) => ids.has(need)) })),
  );
  const depth = new Map(placed.map((spot) => [spot.id, spot.col]));
  const nextRow = new Map<string, number>();
  const row = new Map<string, number>();
  [...known]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => depth.get(a.entry.id)! - depth.get(b.entry.id)! || a.index - b.index)
    .forEach(({ entry }) => {
      const at = Math.max(depth.get(entry.id)!, nextRow.get(entry.lane) ?? 0);
      row.set(entry.id, at);
      nextRow.set(entry.lane, at + 1);
    });
  const laneOf = new Map(known.map((entry) => [entry.id, entry.lane]));

  // Edges, in node order: dependency to dependent.
  const routes: Route[] = [];
  const slots = new Map<string, number>(); // `${lane}/${side}` -> slots used
  const take = (lane: string, side: Side) => {
    const key = `${lane}/${side}`;
    const slot = slots.get(key) ?? 0;
    slots.set(key, slot + 1);
    return slot;
  };
  const channelUse = new Map<number, number>(); // row -> sub-lanes used
  const dotIds: string[] = [];
  for (const entry of known) {
    const targetLane = entry.lane;
    const targetRow = row.get(entry.id)!;
    const sources = [
      ...entry.needs
        .filter((need) => laneOf.has(need))
        .map((need) => ({ id: need, finished: false })),
      ...entry.finishedNeeds.map((need) => ({ id: need, finished: true })),
    ];
    for (const source of sources) {
      const sourceLane = source.finished ? strip : laneOf.get(source.id)!;
      if (source.finished && !dotIds.includes(source.id)) dotIds.push(source.id);
      const sourceIndex = source.finished ? -1 : laneIndex.get(sourceLane)!;
      const targetIndex = laneIndex.get(targetLane)!;
      const same = sourceLane === targetLane;
      const sourceSide: Side = same || sourceIndex < targetIndex ? "right" : "left";
      const targetSide: Side = same ? "right" : sourceIndex < targetIndex ? "left" : "right";
      const sourceSlot = take(sourceLane, sourceSide);
      const targetSlot = same ? sourceSlot : take(targetLane, targetSide);
      let channel: number | null = null;
      if (!same) {
        channel = channelUse.get(targetRow) ?? 0;
        channelUse.set(targetRow, channel + 1);
      }
      routes.push({
        from: source.id,
        to: entry.id,
        finished: source.finished,
        sourceLane,
        targetLane,
        targetRow,
        sourceSide,
        targetSide,
        sourceSlot,
        targetSlot,
        channel,
      });
    }
  }

  // Row tops: a channel of room above each row.
  const rowCount = Math.max(-1, ...row.values()) + 1;
  const channelHeight = (at: number) => Math.max(18, (channelUse.get(at) ?? 0) * stepY + 10);
  const rowTop: number[] = [];
  let cursor = header;
  for (let at = 0; at < rowCount; at++) {
    cursor += channelHeight(at);
    rowTop.push(cursor);
    cursor += node.height;
  }
  const height = cursor + lanePadding;

  // Lane x positions: a gutter on each side sized by the slots it holds.
  const gutter = (lane: string, side: Side) =>
    gutterBase + Math.max(1, slots.get(`${lane}/${side}`) ?? 0) * stepX;
  const hasStrip = dotIds.length > 0;
  const stripWidth = stripMain + gutter(strip, "right");
  let x = 0;
  const stripBox: Box | null = hasStrip ? { x, y: 0, width: stripWidth, height } : null;
  if (hasStrip) x += stripWidth + laneGap;
  const lanes = input.lanes.map((id) => {
    const left = gutter(id, "left");
    const width = left + node.width + gutter(id, "right");
    const box = { x, y: 0, width, height };
    x += width + laneGap;
    return { id, box, nodeX: x - laneGap - width + left };
  });
  const width = x - laneGap;
  const nodeX = new Map(lanes.map((lane) => [lane.id, lane.nodeX]));

  const nodes = known.map((entry) => ({
    id: entry.id,
    lane: entry.lane,
    box: {
      x: nodeX.get(entry.lane)!,
      y: rowTop[row.get(entry.id)!],
      width: node.width,
      height: node.height,
    },
  }));
  const boxOf = new Map(nodes.map((entry) => [entry.id, entry.box]));
  const channelY = (at: number, sub: number) => rowTop[at] - channelHeight(at) + 8 + sub * stepY;

  // Dots sit where their first edge leaves the strip.
  const dotY = new Map<string, number>();
  for (const route of routes)
    if (route.finished && !dotY.has(route.from))
      dotY.set(route.from, channelY(route.targetRow, route.channel!));
  const dotX = stripMain - 10;
  const dots = dotIds.map((id) => ({ id, x: dotX, y: dotY.get(id)! }));

  const slotX = (lane: string, side: Side, slot: number) => {
    if (lane === strip) return stripMain + 4 + slot * stepX;
    const left = nodeX.get(lane)!;
    return side === "right" ? left + node.width + 6 + slot * stepX : left - 6 - slot * stepX;
  };
  const edges = routes.map((route) => {
    const target = boxOf.get(route.to)!;
    const targetY = target.y + node.height / 2;
    const targetEdge = route.targetSide === "left" ? target.x : target.x + node.width;
    const sourceBox = route.finished ? null : boxOf.get(route.from)!;
    const startY = sourceBox ? sourceBox.y + node.height / 2 : dotY.get(route.from)!;
    const startX = sourceBox
      ? route.sourceSide === "right"
        ? sourceBox.x + node.width
        : sourceBox.x
      : dotX + dotRadius;
    const sourceX = slotX(route.sourceLane, route.sourceSide, route.sourceSlot);
    const targetX = slotX(route.targetLane, route.targetSide, route.targetSlot);
    const points: Point[] = [
      [startX, startY],
      [sourceX, startY],
    ];
    if (route.channel === null) points.push([sourceX, targetY]);
    else {
      const sub = channelY(route.targetRow, route.channel);
      points.push([sourceX, sub], [targetX, sub], [targetX, targetY]);
    }
    points.push([targetEdge, targetY]);
    return { from: route.from, to: route.to, finished: route.finished, points: simplify(points) };
  });

  return {
    width,
    height,
    strip: stripBox,
    lanes: lanes.map(({ id, box }) => ({ id, box })),
    nodes,
    dots,
    edges,
  };
}

/** Drops repeated points and points in the middle of a straight run. */
function simplify(points: Point[]): Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    const before = kept.at(-2);
    if (
      last &&
      before &&
      ((before[0] === last[0] && last[0] === point[0]) ||
        (before[1] === last[1] && last[1] === point[1]))
    )
      kept[kept.length - 1] = point;
    else kept.push(point);
  }
  return kept;
}

/** SVG path of an orthogonal polyline with rounded corners. */
export function roundedPath(points: Point[], radius = 5): string {
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let at = 1; at < points.length - 1; at++) {
    const [previousX, previousY] = points[at - 1];
    const [cornerX, cornerY] = points[at];
    const [nextX, nextY] = points[at + 1];
    const before = Math.min(radius, Math.hypot(cornerX - previousX, cornerY - previousY) / 2);
    const after = Math.min(radius, Math.hypot(nextX - cornerX, nextY - cornerY) / 2);
    path += ` L${cornerX - Math.sign(cornerX - previousX) * before},${cornerY - Math.sign(cornerY - previousY) * before}`;
    path += ` Q${cornerX},${cornerY} ${cornerX + Math.sign(nextX - cornerX) * after},${cornerY + Math.sign(nextY - cornerY) * after}`;
  }
  const last = points.at(-1)!;
  return `${path} L${last[0]},${last[1]}`;
}

/** Every (edge, node) pair where a segment of the edge enters the inside of a node box. */
export function crossings(graph: GraphLayout): { from: string; to: string; node: string }[] {
  const found: { from: string; to: string; node: string }[] = [];
  for (const edge of graph.edges)
    for (const { id, box } of graph.nodes)
      for (let at = 1; at < edge.points.length; at++) {
        const [x1, y1] = edge.points[at - 1];
        const [x2, y2] = edge.points[at];
        if (
          Math.max(x1, x2) > box.x &&
          Math.min(x1, x2) < box.x + box.width &&
          Math.max(y1, y2) > box.y &&
          Math.min(y1, y2) < box.y + box.height
        ) {
          found.push({ from: edge.from, to: edge.to, node: id });
          break;
        }
      }
  return found;
}
