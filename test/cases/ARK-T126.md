---
id: ARK-T126
title: ARK-T126 the wall-clock guard fails when a test file gains a sleep, a timer or a millisecond budget above its checked-in count, and the list can only go down
level: integration
technique: boundary values on count (equal passes, one more fails, fewer passes); mutation test on a copy of a spec
priority: high
risk: "a new `waitForTimeout`, `Bun.sleep`, `setTimeout` or `toBeLessThan(<ms>)` enters a test file unnoticed and brings back a timing-dependent test; or the list is raised to make the guard pass"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that `test/wallclock.test.ts` counts the four patterns in each file under `test/` and fails when a file holds more than its count in the checked-in list.

Expected: If a test file holds more matches than its listed count, the guard shall fail and name the file.

## Preconditions

- The checked-in list holds the counts of the base commit (54 lines in 7 files) or lower.
- The guard file and the list are excluded or counted, so the patterns inside them do not trip it.

## Steps

1. Run `bun test test/wallclock.test.ts`: assert it passes on the clean tree.
2. Copy a spec (for example `test/pw/checkpoint.pw.ts`) and append one `await page.waitForTimeout(100)`; run the guard against the copy, or in a scratch copy of the tree.
3. Assert the guard fails and names the file and counts.
4. Repeat with one `Bun.sleep(1)`, one `setTimeout(` and one `toBeLessThan(5000)` line.
5. Remove one match from a listed file (current count below its allowance): assert the guard still passes.
6. History constraint, in a scratch copy of the tree with the base list as the reference: lower one allowance, assert the guard passes; raise one allowance above its base value, assert the guard fails and names the file and both values. A current file with fewer matches than its allowance is a different case (step 5) and is not the same check.

## Expected results

- Clean tree passes.
- Each of the four appended patterns fails the guard with the file named.
- A file below its listed count does not fail.
- A list that raises any allowance above its base value fails the guard; a lowered list passes.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
