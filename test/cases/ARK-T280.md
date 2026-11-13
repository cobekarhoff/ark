---
id: ARK-T280
title: "ARK-T280 the ticket, Roadmap, Runs and plan graphs fit the width of their box down to 60% and then scroll, with Fit, 100% and Full screen controls, at 1024 px and at 1440 px"
level: e2e
technique: "boundary values (scale at fit, at the 60% floor, just above it; widths 1024 and 1440) with equivalence classes of the four graph kinds"
priority: high
risk: "a wide graph shrinks under 60% and its text is unreadable, a graph that fits is scaled up or down, a graph that is wider than the floor does not scroll, the scaled box keeps the unscaled height or scroll width (a CSS transform does not change layout), a control is missing on one of the four graphs, Fit also fits the height of a tall plan, 100% leaves the scale at fit, the plan graph's scroll to the running step is wrong at a scale, or a node test id is duplicated"
status: active
changed_by: 2026-11-12-ARK-325-1
---

## Objective

Prove each of the four graphs, at two widths, scales down to fit the width of its box, never below 60%, scrolls only past the floor, and has working Fit, 100% and Full screen controls with unique graph test ids.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`.
- Hub with project `p`, a Roadmap of 8 milestones in a chain (natural width wider than 1440 px), a Runs board with a graph of 12 tickets in 6 columns, an `ARK-905` ticket graph with 4 columns, and a narrow ticket `ARK-906` with 2 columns (natural width below every box here).
- A run with a plan whose widest row holds 6 steps, and a second run with a plan of 12 rows (taller than the 560 px box) with one running step in a late row.
- The spec reads each graph's natural width `W` (SVG `viewBox` width) and the scroller's `clientWidth` `B`, and sets the viewport width so that `B / W` lands in a chosen class. It asserts the ratio first (step 1), so a fixture that misses its class fails the case before any scale assertion.

## Steps

1. For each of the four graphs (`#/ticket/ARK-905`, `#/roadmap` graph view, `#/runs` graph view, the wide plan on the run page) at 1024 x 800 and then at 1440 x 900 (no other width yet): open it, assert the controls `Fit`, `100%` and `Full screen` are visible, and measure `B` and `W`. Assert the scale (the `data-scale` of the wrapper) and the scroll width at each of the 8 graph-and-width pairs: if `B / W` is below 0.6, scale 0.6 (within 0.01) and `scrollWidth > clientWidth`; if `B / W` is between 0.6 and 1, scale `B / W` (within 0.01) and `scrollWidth <= clientWidth`; if `B / W` is 1 or more, scale 1 and `scrollWidth <= clientWidth`. The Roadmap (wider than 1440 px) must be below the floor at 1024 px and may be at or below it at 1440 px; the 4-column ticket graph must be above the floor at both widths. `checkpoint(page, "graph-fit-1024")` at 1024 px on the Roadmap.
2. Then, for each graph, set the viewport width (adjust by the measured difference between `B` and the viewport) to reach each ratio class, and assert `B / W` before anything else: below the floor (`B / W` in 0.50-0.58), exactly at the floor (`B = ceil(0.6 * W)`, so `B / W` in 0.600-0.605), above the floor (0.70-0.90), and at or above 1 (the graph fits). A graph whose `W` is too small for a class at the viewport range (the narrow `ARK-906` cannot go below 1) is skipped for that class; the other graphs must reach all four.
3. In each class read the scale (the `data-scale` of the wrapper; confirm it against node box width divided by the node's layout width). Assert: below the floor, scale 0.6 (within 0.01) and `scrollWidth > clientWidth`; exactly at the floor, scale 0.6 and `scrollWidth <= clientWidth` (no horizontal scroll at exact fit); above the floor, scale `B / W` (within 0.01) and `scrollWidth <= clientWidth`; at or above 1, scale 1 and no horizontal scroll.
4. Assert the box height equals the scaled graph height (not the unscaled one) for the ticket, Roadmap and Runs graphs, with no empty band under the graph.
5. Click `100%`; assert the scale is 1 and the box scrolls when the graph is wider. Click `Fit`; assert the first scale returns.
6. Assert `ARK-906` has scale 1 at Fit at 1440 px (not enlarged).
7. Open the 12-row plan; assert Fit takes only the width: the scale is not below the width scale, and the box scrolls vertically within its max height.
8. With the running step in a late row, assert after load that the running step node is inside the visible area of the plan box at Fit and at 100%.
9. Assert `getByTestId("graph-node")` (or `step-node`) counts equal the node count on each page in every class, so the wrapper adds no copy.

## Expected results

- When a graph is wider than its box, the system shall scale it down to fit the width, to 60% at the smallest, and scroll only below that.
- The system shall give each of the four graphs the controls Fit, 100% and Full screen.
- When a graph fits at 100%, the system shall not scale it up.
- When the plan graph has a running step, the system shall scroll it into view at any scale.

## Screenshot checkpoints

- `graph-fit-1024`: the Roadmap graph at 1024 px at fit scale with its three controls.
