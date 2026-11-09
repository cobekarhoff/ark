---
id: ARK-T144
title: ARK-T144 the page of a merged closed run opens with a summary band of outcome, wall time, ACs and metrics
level: integration
technique: equivalence classes (merged run with metrics, every band value distinct)
priority: high
risk: the band shows a value from the wrong source (wall time from `metrics.time` instead of `run.started`/`run.closed`, ACs counted from the wrong statuses, cost or rounds mixed up), is missing, or sits below the plan
status: active
changed_by: 2026-11-09-ARK-353-1
---

## Objective

Prove that a merged closed run's page shows a summary band above the plan with each of the five values read from its source.

## Preconditions

- A hub started on a scratch `ARK_HOME` with real run folders (events, `state.json`, files), real snapshot and `runDetail()` code, and a real browser (Playwright, `test/pw/hub.pw.ts`). No mocks of the page or of the snapshot.
- A merged run: `run.started` at T0 and `run.closed` at T0+1h12m with outcome merged; `state.json` with 4 criteria, 3 `passing` and 1 not passing (count 3 of 4); `metrics.json` in the real writer format `{"cost":{"total_usd":4.20},"rework":{"rounds":2},"time":{"wall_seconds":60}}`, so `time.wall_seconds` differs from the event time.

## Steps

1. Open the page of the merged run.
2. Read the band by its `data-testid`.
3. Compare the band's position with the plan.
4. Read the value of each field.

## Expected results

- When a closed run's page opens, the system shall show the band above the plan.
- The band shall show the outcome `merged`.
- The band shall show the wall time `1h 12m`, from the two events, not the `metrics.json` value.
- The band shall show `3 of 4` ACs passing, from `state.json`.
- The band shall show the cost `$4.20` and `2` rework rounds, from `metrics.json`.
- The outcome shall not show twice (band and old closed banner).

## Screenshot checkpoints

Full page of the merged run, band in view above the plan.
