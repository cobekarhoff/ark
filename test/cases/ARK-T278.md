---
id: ARK-T278
title: "ARK-T278 the ticket page puts a 10-ticket graph in a full-width band with no horizontal scroll at 1440 px, prose and relations in two columns under it, and an empty relation as one line"
level: e2e
technique: "boundary values (1440 px and 1100 px widths, empty and non-empty relations) with equivalence classes of graph depth"
priority: high
risk: "the graph stays in a 420 px side column, the page keeps its 1280 px cap and leaves the right side empty at 1440 px, a graph with deep columns still scrolls sideways in the band, the prose runs wider than about 72 characters, the relations land in the left column, or an empty Depends on or Unblocks keeps a block with a long sentence"
status: active
changed_by: 2026-11-12-ARK-325-1
---

## Objective

Prove that at 1440 px the ticket graph band is as wide as the page, that a graph with deep columns fits it without horizontal scroll, that the Problem, Change and Evidence column has a measure of about 72 characters and sits left of the Depends on, Unblocks and criteria column, and that an empty relation is one line.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a hub with project `p` and fake Orca tools; viewport 1440 x 900.
- Base ticket `ARK-901` with 10 tickets in its graph, built so that it has at least 4 columns: a chain of upstream tickets that each depend on the next, and several downstream tickets. Its Problem, Change and Evidence hold long paragraphs, and it has 3 criteria.
- Ticket `ARK-902` with no `depends_on` and no ticket that depends on it.

## Steps

1. Set the viewport to 1440 x 900; open `#/ticket/ARK-901`. `checkpoint(page, "ticket-band-1440")`.
2. Assert `ticket-graph` shows 10 `graph-node` elements.
3. Measure the band (the graph box), the page content and the two columns with `getBoundingClientRect`. Assert the band left and right edges equal those of the content width (within 2 px) and the band is above both columns and under the title.
4. Assert the graph scroller has `scrollWidth <= clientWidth`.
5. Assert the right edge of the right column is within 2 px of the right edge of the band (no empty right side) and the left column is left of the right column.
6. Read the computed width of a Problem paragraph in `ch` (width divided by the width of `0` in that font); assert it is between 60 and 85.
7. Assert `depends-on`, `unblocks-list` and the criteria are inside the right column and the Problem, Change and Evidence sections are inside the left one.
8. Open `#/ticket/ARK-902`. Assert the Depends on block reads `Depends on · none` and the Unblocks block reads `Unblocks · none`, each with a height below 40 px and no sentence of more than 3 words.
9. Set the viewport to 1000 x 900; open `#/ticket/ARK-901`; assert `document.documentElement.scrollWidth <= innerWidth`.

## Expected results

- When a ticket page opens at 1440 px, the system shall draw its graph in a band as wide as the page, with no horizontal scroll for a 10-ticket graph.
- The system shall show the Problem, Change and Evidence sections in a left column of about 72 characters, and Depends on, Unblocks and the criteria in a right column that reaches the right edge of the band.
- When a relation is empty, the system shall show it as one short line.

## Screenshot checkpoints

- `ticket-band-1440`: the ticket page of `ARK-901` at 1440 px, the band across the page and two columns under it.
