---
id: ARK-T117
title: ARK-T117 Esc from a ticket page returns the Roadmap to the scroll position read while the nav source labels showed, after the labels vanish
level: e2e
technique: state transition (labels shown, position read, labels gone, ticket opened, Esc) with the late answer forced by a hold gate on the fake tools
priority: high
risk: "the nav changes height when the source labels vanish, so the page content moves and Esc settles on a different scroll position than the one read (base commit: expected 1501, received 1460); a gate that misses one fake tool lets a source answer early, so the labels are gone before the read and the case passes at base"
status: active
changed_by: 2026-11-08-ARK-363-1
---

## Objective

Prove that Esc from a ticket page returns the Roadmap to the scroll position it had when the ticket opened, also when the source labels in the nav were showing when that position was read and vanish before Esc. Fails at the base commit, passes at head.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, same Roadmap data as ARK-T26 (project `p`, 44 open tickets, `ARK-701` selected first), viewport of the other hub specs.
- Hold gate: one environment variable names a file. While the file is missing, each fake tool (`orca`, `gh`, `plannotator`, `omp`) waits; the test releases them by writing the file. The gate is set before the hub starts, the wait is bounded, and test cleanup writes the file, so a failing case does not hang the suite.
- At least 4 sources have not answered, so 4 or more `stale-label` elements show in the nav.

## Steps

1. Set the gate, start the hub with the fake tools held, and open `#/roadmap`.
2. Assert at least 4 `stale-label` elements show.
3. Press `j` 30 times and read `scrollY` as `before` (above 100); record the selected ticket.
4. Release the tools by writing the gate file; wait for 0 `stale-label` elements.
5. Press Enter; assert the URL is `#/ticket/<id>`.
6. Press Esc; assert the URL is `#/roadmap` and the same row is selected.
7. Poll `scrollY` and compare it with `before`.

## Expected results

- When Esc is pressed on the ticket page after the source labels vanished, the system shall return the Roadmap to the same selected row.
- The scroll position after Esc shall equal `before` exactly (at base: 1460 against 1501).
- The case reads `before` while 4 or more labels show and presses Esc with 0 labels, at head and at base alike (a read after the labels vanished makes the case pass at base).

## Screenshot checkpoints

none: the proof is a numeric scroll position; the labels' presence is asserted by element count.
