---
id: ARK-T126
title: ARK-T126 the wall-clock guard fails when a test file gains a sleep, a timer or a millisecond budget above its checked-in count, or a `*.pw.ts` file gains a date read, and the list can only go down
level: integration
technique: boundary values on count (equal passes, one more fails, fewer passes); mutation test on a copy of a spec
priority: high
risk: "a new `waitForTimeout`, `Bun.sleep`, `setTimeout` or `toBeLessThan(<ms>)` enters a test file, or a `new Date(` or `Date.now(` enters a `*.pw.ts` file, unnoticed and brings back a time-of-day-dependent test; or the list is raised to make the guard pass"
status: active
changed_by: 2026-11-13-ARK-433-1
---

## Objective

Prove that `test/wallclock.test.ts` counts the four patterns in each file under `test/` and fails when a file holds more than its count in the checked-in list. It also counts `new Date(` and `Date.now(` in `*.pw.ts` files against a limit of 0, kept apart from the list.

Expected: If a test file holds more matches than its listed count, or a `*.pw.ts` file holds any date read, the guard shall fail and name the file.

## Preconditions

- The checked-in list holds the counts of the base commit (54 lines in 7 files) or lower.
- The guard file and the list are excluded or counted, so the patterns inside them do not trip it.

## Steps

1. Run `bun test test/wallclock.test.ts`: assert it passes on the clean tree. The clean-tree date count (0 in every `*.pw.ts` file, no allowance) is owned by ARK-T349, not asserted here.
2. Copy a spec (for example `test/pw/checkpoint.pw.ts`) and append one `await page.waitForTimeout(100)`; run the guard against the copy, or in a scratch copy of the tree.
3. Assert the guard fails and names the file and counts.
4. Repeat with one `Bun.sleep(1)`, one `setTimeout(` and one `toBeLessThan(5000)` line.
   4a. Date reads: append each of `const d = new Date();` and `const n = Date.now();` to the text of `test/pw/checkpoint.pw.ts` (one line per run, on a copy of the text, not the file) and check the guard result: it fails and names `test/pw/checkpoint.pw.ts`, with the count grown from 0 to 1. A `// new Date(` comment line appended does not fail it. The same line in a `*.test.ts` file is not counted by the date list.
5. Remove one match from a listed file (current count below its allowance): assert the guard still passes.
6. History constraint, in a scratch copy of the tree with the base list as the reference: lower one allowance, assert the guard passes; raise one allowance above its base value, assert the guard fails and names the file and both values. A current file with fewer matches than its allowance is a different case (step 5) and is not the same check.

## Expected results

- Clean tree passes.
- Each of the four appended patterns fails the guard with the file named.
- `new Date(` and `Date.now(` appended to `checkpoint.pw.ts` each fail the guard with the file named; the date list takes no allowance, so the list cannot admit them.
- A file below its listed count does not fail.
- A list that raises any allowance above its base value fails the guard; a lowered list passes.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
