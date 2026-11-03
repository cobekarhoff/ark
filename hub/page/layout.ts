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
 * Path for an edge that skips columns: it leaves the box, rises into the lane above every box, runs
 * along it and drops into the target, so it never passes behind a box of a column between.
 */
export function detourPath(x1: number, y1: number, x2: number, y2: number, lane: number): string {
  return `M${x1},${y1} C${x1 + 30},${y1} ${x1 + 30},${lane} ${x1 + 60},${lane} L${x2 - 60},${lane} C${x2 - 30},${lane} ${x2 - 30},${y2} ${x2},${y2}`;
}
