---
id: ARK-T152
title: ARK-T152 Runs shows every run on one board and graph with filters, rings of steps done, dashed edges to open tickets and what each run unblocks
level: integration
technique: equivalence classes of run state (queued, building, awaiting merge, closed) plus filter state transitions
priority: medium
risk: the Runs page drops a run from the board or graph, miscounts a filter, shows a wrong steps-done ring, loses a dashed edge to an open ticket or the unblock list, or shows an older-runs control when the Closed lane has fewer than one page
status: active
changed_by: 2026-11-09-ARK-353-1
---

## Objective

Prove that the Runs page shows every run on one board and one graph, with the Active, Queued and Old filters, rings of steps done, dashed edges to tickets that are not done, and the list of what each run unblocks. The Closed lane shows its first page and no older-runs control when all closed runs fit.

## Preconditions

- Hub started on a fake project `p` with isolated state.
- Two building runs (ARK-601 with 1 of 3 steps done, ARK-602 with a long title), a queued ticket ARK-603 that depends on ARK-601, an awaiting-merge ticket ARK-604 that depends on the closed ARK-611, and six closed runs ARK-611 to ARK-616 where ARK-612 depends on ARK-611.

## Steps

1. Open the Runs page.
2. Read the lanes and the cards in each.
3. Read the ring of ARK-601 and the title of ARK-602.
4. Read the filter counts, then use the filters and read the graph nodes and edges.

## Expected results

- When the Runs page opens, the system shall show no run picker and the five lanes Queued, Building, Needs me, Awaiting merge, Closed in that order, with 1, 2, 0, 1 and 6 cards.
- When the Closed lane holds fewer closed runs than one page, the system shall show all of them and no older-runs control.
- When a run has steps, the system shall show a ring with the steps done and the steps total (1 of 3 for ARK-601), and a long title wraps to 2 lines.
- When the page opens, the Active filter shall be pressed with count 3, Queued shall show 1 and Old shall show 6 tickets (labelled apart from the Closed run count, see ARK-T226), and the graph shall show ARK-601 to ARK-604.
- When a ticket depends on one that is not done, the system shall draw a dashed edge (ARK-601 to ARK-603), and each run shall list what it unblocks.

## Screenshot checkpoints

Runs page after load: five lanes with cards and rings, and the graph with its dashed edge.
