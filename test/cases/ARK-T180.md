---
id: ARK-T180
title: ARK-T180 the run page shows the four time parts as one bar, in the closed band without metrics.json and at the top of an open run
level: e2e
technique: equivalence classes (closed run with no metrics, open run) with the page as the observable
priority: high
risk: the bar reads `metrics.json` and is missing for a closed run without one, it is not shown at the top of an open run, or its minutes differ from the function over the events
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that the hub run page renders one bar with the four parts and their minutes, computed from the events: in the ARK-353 summary band of a closed run that has no `metrics.json`, and at the top of the page of an open run.

## Preconditions

- Real hub server and Playwright, with a fixture `ARK_HOME` (pattern of the ARK-353 closed-run specs in `test/pw/hub.pw.ts`).
- Closed run A: events of the ARK-T174 fixture scaled to minutes (waiting on you 20, working 20, waiting to merge 30, idle 20 min), no `metrics.json` file.
- Open run B: no `run.closed`, a step running and a gate open; the clock `now` fixed by the test so the parts are fixed (for example waiting on you 10, working 30, idle 5 min, no MR).

## Steps

1. Open the run page of A.
2. Read the band and the bar, with the minutes of each part.
3. Open the run page of B and read the top of the page.

## Expected results

- A: the ARK-353 summary band holds one bar with four segments labelled waiting on you, working, waiting to merge and idle with 20, 20, 30 and 20 min, in that order; the page has no error for the missing `metrics.json`.
- B: a bar is at the top of the page (no closed band exists for an open run) with 10, 30, 0 and 5 min, and the segment widths follow the minutes.
- The hub only reads: no button or request on the page changes state.

## Screenshot checkpoints

- `closed-no-metrics-bar`: run A band with the bar and the four minute labels.
- `open-run-top-bar`: run B page top with the bar.
