---
id: ARK-T145
title: ARK-T145 a closed run with no or damaged metrics.json shows 'not recorded' for cost and rounds and keeps the other values
level: integration
technique: equivalence classes (metrics absent, metrics damaged, metrics present) and boundary (zero criteria)
priority: high
risk: a missing or damaged `metrics.json` throws and the whole page fails, or the band shows $0 and 0 rounds as if they were recorded, or the outcome, wall time and ACs vanish with the metrics, or an aborted run with no criteria shows NaN
status: active
changed_by: 2026-11-09-ARK-353-1
---

## Objective

Prove that without usable metrics the band says 'not recorded' for cost and rounds only.

## Preconditions

- A hub started on a scratch `ARK_HOME` with real run folders (events, `state.json`, files), real snapshot and `runDetail()` code, and a real browser (Playwright, `test/pw/hub.pw.ts`). No mocks of the page or of the snapshot.
- Run A: closed merged, 2 of 3 ACs passing, no `metrics.json`.
- Run B: closed merged, `metrics.json` holding invalid JSON.
- Run C: closed aborted, zero criteria, no `metrics.json`.

## Steps

1. Open the page of run A, read the band.
2. Open the page of run B, read the band.
3. Open the page of run C, read the band.

## Expected results

- When `metrics.json` is absent (A) or damaged (B), the band shall show `not recorded` for the cost and for the rounds.
- The band shall still show the outcome, the wall time and `2 of 3` ACs.
- The page shall load without an error for B.
- For C the band shall show outcome `aborted`, a wall time, and `0 of 0` or a dash for ACs, never `NaN`.
- The cost shall not show `$0` for A, B or C.

## Screenshot checkpoints

Band of run A (not recorded visible).
