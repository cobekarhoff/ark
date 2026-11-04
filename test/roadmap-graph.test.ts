import { expect, setDefaultTimeout, test } from "bun:test";
import { crossings, layoutGraph, type GraphInput } from "../hub/page/roadmap-graph.ts";

setDefaultTimeout(180_000);

/** Invariant of the Roadmap graph: no edge passes through a node it does not join, whatever the shape. */
test("roadmap graph routes no edge through a node, for random graphs with shared lanes and columns", () => {
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let round = 0; round < 60; round++) {
    const lanes = ["M1", "M2", "M3", "M4"].slice(0, 1 + Math.floor(random() * 4));
    const count = 2 + Math.floor(random() * 25);
    const nodes: GraphInput["nodes"] = [];
    for (let at = 0; at < count; at++) {
      const needs = nodes.filter(() => random() < 0.15).map((entry) => entry.id);
      const finishedNeeds = random() < 0.3 ? [`D${Math.floor(random() * 5)}`] : [];
      nodes.push({
        id: `T${at}`,
        lane: lanes[Math.floor(random() * lanes.length)],
        needs,
        finishedNeeds,
      });
    }
    const graph = layoutGraph({ lanes, nodes });
    expect(crossings(graph)).toEqual([]);
    const wanted = nodes.reduce(
      (sum, entry) => sum + entry.needs.length + entry.finishedNeeds.length,
      0,
    );
    expect(graph.edges.length).toBe(wanted);
  }
});
