/** Layered left-to-right layout shared by the Run DAG and the Map: column = longest path from a root. */
export type GraphNode = { id: string; needs: string[] };
export type Placed = { id: string; col: number; row: number };
export type Edge = { from: string; to: string };

export function layout(nodes: GraphNode[]): { placed: Placed[]; edges: Edge[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const column = new Map<string, number>();
  const visiting = new Set<string>();
  const columnOf = (id: string): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a cycle: break it instead of looping
    visiting.add(id);
    let result = 0;
    for (const need of byId.get(id)!.needs)
      if (byId.has(need)) result = Math.max(result, columnOf(need) + 1);
    visiting.delete(id);
    column.set(id, result);
    return result;
  };
  const rows = new Map<number, number>();
  const placed = nodes.map(({ id }) => {
    const col = columnOf(id);
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return { id, col, row };
  });
  // An edge needs both ends: a dependency on a ticket that is not listed has nothing to draw to.
  const edges = nodes.flatMap((node) =>
    node.needs.filter((need) => byId.has(need)).map((need) => ({ from: need, to: node.id })),
  );
  return { placed, edges };
}

/** Cubic path from the right edge of one box to the left edge of the next. */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const middle = (x1 + x2) / 2;
  return `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`;
}

/**
 * Path for an edge that skips columns: it leaves the box into the gap after its column, rises to
 * `lane` (above every box), runs along it and drops in the gap before the target, so it never passes
 * behind a box. `reach` is how far into those gaps the two vertical runs stand: it stays under the
 * gap, and each edge takes its own so that two edges never share a vertical run.
 */
export function detourPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lane: number,
  reach: number,
): string {
  const corner = 6;
  const points = [
    [x1, y1],
    [x1 + reach, y1],
    [x1 + reach, lane],
    [x2 - reach, lane],
    [x2 - reach, y2],
    [x2, y2],
  ];
  let path = `M${x1},${y1}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [previousX, previousY] = points[i - 1]!;
    const [x, y] = points[i]!;
    const [nextX, nextY] = points[i + 1]!;
    const before = Math.min(corner, Math.hypot(x - previousX, y - previousY) / 2);
    const after = Math.min(corner, Math.hypot(nextX - x, nextY - y) / 2);
    path += ` L${x - Math.sign(x - previousX) * before},${y - Math.sign(y - previousY) * before}`;
    path += ` Q${x},${y} ${x + Math.sign(nextX - x) * after},${y + Math.sign(nextY - y) * after}`;
  }
  return `${path} L${x2},${y2}`;
}
