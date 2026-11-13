---
id: ARK-T117
title: ARK-T117 Esc from a ticket page returns the Roadmap to the scroll position read while the stale chip showed, after the chip vanishes
level: e2e
technique: state transition (chip shown, position read, chip gone, ticket opened, Esc) with the late answer forced by a hold gate on the fake tools
priority: high
risk: "the nav changes height when the stale chip vanishes, so the page content moves and Esc settles on a different scroll position than the one read (base commit: expected 1501, received 1460); a gate that misses one fake tool lets a source answer early, so the chip is gone before the read and the case passes at base; the old `>=4 stale-label` check no longer exists, so a case that still counts labels waits forever"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that Esc from a ticket page returns the Roadmap to the scroll position it had when the ticket opened, also when the stale chip in the nav was showing when that position was read and vanishes before Esc. Fails at the base commit, passes at head. Updated from per-source labels to the single chip (ARK-335).

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, same Roadmap data as ARK-T26 (project `p`, 44 open tickets, `ARK-701` selected first), viewport of the other hub specs.
- Hold gate: one environment variable names a file. While the file is missing, each fake tool (`orca`, `gh`, `plannotator`, `omp`) waits; the test releases them by writing the file. The gate is set before the hub starts, the wait is bounded, and test cleanup writes the file, so a failing case does not hang the suite.
- At least 4 sources have not answered, so the one stale chip shows in the nav.

## Steps

1. Set the gate, start the hub with the fake tools held, and open `#/roadmap`.
2. Assert the stale chip shows and lists 4 or more sources.
3. Press `j` 30 times and read `scrollY` as `before` (above 100); record the selected ticket.
4. Release the tools by writing the gate file; wait for the stale chip to vanish.
5. Press Enter; assert the URL is `#/ticket/<id>`.
6. Press Esc; assert the URL is `#/roadmap` and the same row is selected.
7. Poll `scrollY` and compare it with `before`.

## Expected results

- When Esc is pressed on the ticket page after the stale chip vanished, the system shall return the Roadmap to the same selected row.
- The scroll position after Esc shall equal `before` exactly.
- The case reads `before` while the chip shows and presses Esc with no chip, at head and at base alike.

## Screenshot checkpoints

none: the proof is a numeric scroll position; the chip's presence is asserted by element.
