---
id: ARK-T260
title: ARK-T260 Runs draws one node for each ticket and one edge for each depends_on, colored by the newest run's phase, and a ready ticket is queued because the Orca queue holds its Task
level: e2e
technique: equivalence classes of ticket state (building, needs me, blocked, queued) plus graph structure
priority: medium
risk: the Runs graph drops a node or an edge, shows a wrong state or color for a ticket, or shows a ready ticket as queued or as approved, not queued by the timing of the queue read instead of by the Orca queue
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove that the Runs graph draws one node for each ticket and one edge for each `depends_on`, colored by the phase of the newest run, and that a ready ticket with no unfinished dependency shows as queued only because the Master Chief Run holds its Task.

## Preconditions

- Hub started on a fake project `p` with isolated state, and a fake `orca` whose Master Chief Run (`Master Chief: p tickets`) holds the ready Task `ARK-905 Ticket ARK-905`.
- Tickets ARK-901 to ARK-905, all ready: ARK-902 and ARK-903 depend on ARK-901, ARK-904 on ARK-902 and ARK-903. ARK-901 has an older closed run and a newer building one, ARK-903 a planning run.

## Steps

1. Open the Runs page, then the Queued filter.
2. Read the state and color of each graph node and the edges.

## Expected results

- When the Runs page opens, the graph shall show 4 nodes (ARK-901 to ARK-904) and ARK-905 under the Queued filter, with 5 nodes.
- When a ticket has a building run, a planning run, or an unfinished dependency, the node shall show building (ARK-901), needs me (ARK-903) and blocked (ARK-902, ARK-904).
- When the queue holds the Task of ARK-905, its node shall show queued.
- The graph shall draw 4 edges, one for each depends_on.

## Screenshot checkpoints
