---
id: ARK-T774
title: ARK-T774 a scenario wait for a marker that never appears gives up at its 20 s default limit, before the test timeout, and its error names the missing marker and lists the files in the scenario home
level: integration
technique: boundary values on the default limit (no reject before 20 s, reject before the 25 s test timeout); error guessing on the message (missing name, listing of files not asked for)
priority: high
risk: "the scenario `waitFor` of `test/test-lock.test.ts` has no limit again (a lost marker hangs to the 90 s test timeout with no name, as ARK-T155 did in 6 full runs), its default limit is cut so a slow child under host load fails early, or its error says only that it timed out: it drops the missing marker name or the `readdirSync` of the home, so a hang does not say which wait did not end"
status: active
changed_by: 2026-11-21-ARK-618-1
---

## Objective

Prove that a scenario of `describe("ark test budget admission")` in `test/test-lock.test.ts` that waits for a marker no process writes ends with a named error at the default limit of `waitFor`, not at the 90 s test timeout. Serves ARK-618/AC1.

Expected: When a scenario calls `waitFor` with marker names only (so the 20 s default limit applies) for a marker that never appears, the wait shall reject after 20 s and no later than 25 s, and its error shall name the missing marker and list the files in the scenario home.

## Preconditions

- The real `scenario()` helper of `test/test-lock.test.ts` with its temp home; no child process is started (no child writes the asked marker).
- The test writes one marker file `present-running` into the scenario home itself before the wait. It is not one of the names asked for, so the only way the error can name it is the listing of the home.
- The test's own timeout is 25 s (the third argument of `test(...)`, a named constant), so a wait without a limit fails at 25 s and not at 90 s. No `setTimeout(`, no `toBeLessThan(<3+ digits>)`: the wall-clock guard (ARK-T126) gives this file no allowance.
- This is the only case that waits until the 20 s default ends. ARK-T775 calls `waitForWithin(1000, ...)` with a 1 s limit. The ARK-T155 scenario tests (`test/test-lock.test.ts:744-813`) and the ARK-T721 scenario test (`:855-892`) call `waitFor` with names only and so run with the 20 s default, but their markers appear and their waits end early. The other ARK-T155 tests (`test/budget.test.ts`, `test/test-lock.test.ts:1262`) do not use `scenario()`.

## Steps

1. In a scenario, write `present-running` into `home`.
2. Note `performance.now()` and call `waitFor("ghost-running")` (one marker name, no other argument).
3. Await its rejection and note `performance.now()` again.

## Expected results

- Step 3: the wait rejects (it does not resolve, and the test does not reach its 25 s timeout).
- The time from step 2 to the rejection is at least the 20 s default (a named constant, asserted with `toBeGreaterThanOrEqual`), so the default is the 20 s of the ticket and not a shorter value.
- The error message contains `ghost-running` (the missing marker) and `present-running` (a file that exists in the home and was not asked for). The test asserts that both names are in the message, never the whole listing or its order: the home also holds other files.
- The scenario's `finally` removes the home after the rejection.

Validator notes: at base `waitFor` has no limit and the test fails at its 25 s timeout, which is the red proof. Under host load a 25 ms poll can fire late; the 5 s gap between the limit and the test timeout is the margin, and a failure at 25 s is a flake to report, not a reason to raise the timeout.

## Screenshot checkpoints

None. The surface is a rejected promise in a test file; no screenshot applies.
