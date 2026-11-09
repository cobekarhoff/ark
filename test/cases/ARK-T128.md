---
id: ARK-T128
title: ARK-T128 the hover contrast check in ARK-T96 waits for the first action to be visible and the colour transition to end, and it passes when the first snapshot is late
level: e2e
technique: fault injection (gate that delays the first snapshot); state wait instead of fixed delay
priority: high
risk: "the test checks `count()` above 0 after a fixed 400 ms and fails when the first snapshot comes late (2 in 59 runs: count 0 at 1.5 s), or checks a colour mid-transition"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that the hover and colour check of ARK-T96 (the single owner of the theme and contrast contract; ARK-T96 is `update`, this case adds only the late-snapshot proof) waits for the state itself and asserts the first action is visible, so the order or delay of the first snapshot does not decide the result.

Expected: When the first snapshot is delayed, the test shall wait for the action to be visible and pass.

## Preconditions

- Fake tools with a gate that holds the first snapshot until the test releases it (the gate of ARK-363 if merged, else this run's own).

## Steps

1. Open the page with the gate closed; hover is applied to the target.
2. Release the gate after a delay longer than the old 400 ms.
3. Wait for the first action to be visible (`toBeVisible`) and for the transition to end (computed style stable or `transitionend`); assert the hover colour.
4. Run `bunx playwright test test/pw/hub.pw.ts -g "ARK-T96"` (the test titled `ARK-T96 the theme follows the system, ...`, `test/pw/hub.pw.ts:2180`).

## Expected results

- The action is visible and the hover colour is the final one.
- The test passes with the first snapshot held.

## Screenshot checkpoints

hover-state-final: after the action is visible and the transition ended, before the colour assertion.
