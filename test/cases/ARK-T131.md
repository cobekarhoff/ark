---
id: ARK-T131
title: ARK-T131 ARK-285-AC9 reads the scroll position after the layout settles and passes when the layout settles late
level: e2e
technique: fault injection (forced late layout); state wait instead of immediate read
priority: high
risk: "the test reads the scroll position before layout settles and sees a 6.3 px gap (received 554.41, needs more than 560.70), so it fails under load though the page is right"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that the scroll check reads the position only after layout is stable, so a late layout does not fail it.

Expected: When the layout settles late, the test shall read the scroll position after it settled and pass.

## Preconditions

- A test-owned gate (a route that holds the font or stylesheet until the test fulfils it) forces a late layout change; nothing is added to product code. The test sets a flag when the gate is released and the layout changed.
- At base the forced late layout reproduces the 6.3 px gap; if it does not, the report says so.

## Steps

1. Open the page with the gate closed.
2. Release the gate and wait for its completion event (the route fulfilled and the font or style loaded, e.g. `document.fonts.ready` or a `load` event on the style); assert the layout change actually occurred (a bounding box differs from its pre-release value).
3. Only then wait for final geometry (the bounding box equal across consecutive frames after the change), read the scroll position and assert it meets the limit of ARK-285-AC9. A stable interval before the release does not count.
4. Run the same file at base: the immediate read must fail with the forced change (base proof); if it does not, the report says so.
5. Run `bunx playwright test test/pw/hub.pw.ts -g ARK-285-AC9`.

## Expected results

- The layout change is shown to have happened, the position is read after it, and the assertion holds at head.
- The base file shows the 6.3 px gap with the forced late layout.

## Screenshot checkpoints

layout-settled: after the layout is stable, before the scroll assertion.
