---
id: ARK-T149
title: ARK-T149 the Closed lane shows 20 closed runs with outcome and cost and Show more adds 20 until all 45 show
level: integration
technique: boundary values (20, 40, 45 of 45) and equivalence classes (cost recorded / not recorded)
priority: high
risk: the lane still stops at 5, a page adds the wrong count or repeats runs, the control stays after the last run, a card has no outcome or cost source, a run without `metrics.json` shows $0, or the old `older-runs` control and 'last 5' hint remain
status: active
changed_by: 2026-11-09-ARK-353-1
---

## Objective

Prove that paging by 20 reaches every closed run and that each card shows outcome and cost.

## Preconditions

- A hub started on a scratch `ARK_HOME` with real run folders (events, `state.json`, files), real snapshot and `runDetail()` code, and a real browser (Playwright, `test/pw/hub.pw.ts`). No mocks of the page or of the snapshot.
- 45 closed runs in one project with distinct close times; most merged, some aborted; at least 3 without `metrics.json`; a few open runs for contrast.

## Steps

1. Open the Runs page and count the cards in the Closed lane.
2. Read outcome and cost on the first and last card, and on a card without metrics.
3. Click `Show more`, count the cards.
4. Click again, count the cards.
5. Check the control and the old `older-runs` control.

## Expected results

- The lane shall first show the 20 newest closed runs, newest first.
- Each card shall show its outcome and its cost; a run without `metrics.json` shall show `not recorded`, not `$0`.
- After one click the lane shall show 40 cards with no repeat; after the second click 45.
- When all 45 show, the `Show more` control shall be gone.
- The `older-runs` control and the 'last 5' hint shall not exist.
- The open lanes shall be unchanged.

## Screenshot checkpoints

Closed lane at 20, and at 45 with no control.
