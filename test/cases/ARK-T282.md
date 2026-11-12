---
id: ARK-T282
title: "ARK-T282 a ticket-graph edge that skips a column runs between the nodes and crosses no node box it does not join, with three skip edges"
level: integration
technique: "boundary values (an edge that spans 1, 2 and 3 columns) with a sampled geometry check of each path against every node box"
priority: high
risk: "an edge that skips a column is one cubic through the cards between its ends, a detour lane is outside the SVG and is clipped, several skip edges in one row share a lane and overlap, the way back down crosses a card above the target, or the ticket page still filters its graph to the base ticket so no skip edge exists"
status: active
changed_by: 2026-11-12-ARK-325-1
---

## Objective

Prove that in a ticket graph with three edges that skip a column, no edge path passes through the box of a node it does not join, and that every path stays inside the graph SVG.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`; viewport 1440 x 900.
- Ticket `ARK-907` whose graph holds 4 columns: `ARK-907` and its tickets across columns, and 3 edges that join nodes 2 or 3 columns apart, two of them in one row and one passing behind a card that sits above its target. The data must put these edges in the ticket graph (the ticket page must pass them, not only edges to the base ticket).

## Steps

1. Open `#/ticket/ARK-907`. Assert `graph-edge` count equals the edge count of the fixture, and 3 of them have `data-from` and `data-to` more than one column apart (by the x of the node boxes).
2. For each `graph-edge`, sample its path with `getPointAtLength` every 4 px. Convert the points to screen pixels with the SVG screen transform.
3. For each sample, assert it is outside the box (grown 0 px) of every node except `data-from` and `data-to`, with a margin of 2 px at the ends of the path where the path meets its own nodes.
4. Assert every sample is inside the SVG box (no clip), and the SVG height has grown to hold the detour lane.
5. Assert the 3 skip edges do not share the same lane (the max or min y of their paths differs by at least 4 px where they share a row).
6. `checkpoint(page, "ticket-skip-edges")`.

## Expected results

- When an edge of the ticket graph joins nodes in columns that are not next to each other, the system shall draw it around the nodes between them.
- No edge path shall cross the box of a node it does not join and every path shall stay inside the graph SVG.

## Screenshot checkpoints

- `ticket-skip-edges`: the ticket graph of `ARK-907` with the 3 skip edges drawn above the cards.
