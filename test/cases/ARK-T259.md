---
id: ARK-T259
title: ARK-T259 Roadmap Now shows cards and Next, Later and Unranked rows in rank order with the derived ticket state
level: e2e
technique: equivalence classes over horizon and ticket state
priority: medium
risk: "Roadmap rows lose rank order, a finished ticket shows in a list, or the chip shows the stored status instead of the derived state (run phase, approved not queued, blocked)"
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove the Roadmap lists tickets by horizon in rank order and each chip shows the derived state.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, project `p`, a roadmap with Now, Next and Later ranks, an unranked ticket and a finished ticket, one open run, and a fake `orca` whose queue holds no Task.

## Steps

1. Open the Roadmap.
2. Read the sections, rows, ranks and status chips.

## Expected results

- When the Roadmap opens, the system shall list the sections Now, Next, Later, Unranked in order and the tickets in rank order, with Now as cards and the finished ticket in no list.
- Each chip shall show the derived state: the run phase for a ticket with an open run, `approved, not queued` for a ready ticket with no Task, `proposed`, and `blocked` for an unfinished dependency.

## Screenshot checkpoints

None.
