---
id: ARK-T132
title: ARK-T132 ARK-292-AC1 the 300 ms timeout of the hanging close does not leak into a later close against a slow orca, and the slow orca is released by the test, not by a timed answer
level: integration
technique: state transition (hang case sets a short timeout, then a later close must run without it); state release instead of timed answer
priority: high
risk: "the short ARK_ORCA_TIMEOUT_MS of the hang case stays in the process environment, so a later close times out against a slow orca and prints an orca line; or the slow orca answers by a timer and the test fails under host stall"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that the hanging-orca close cleans up its 300 ms reader timeout, and that a later close against a slow orca waits for the answer and releases the worker.

Expected: When a close with a 300 ms reader timeout has ended, the next close shall start with no reader timeout set and shall wait for a slow orca to answer.

## Preconditions

- `test/run.test.ts` runs the hanging close helper, then a fake orca that holds its first call until the test releases it and logs the `ARK_ORCA_TIMEOUT_MS` it started with.
- The variable holds an outer value (or none) before the hanging close runs.

## Steps

1. Run the hanging close; it sets the 300 ms timeout and restores the outer value when it ends.
2. Check that `ARK_ORCA_TIMEOUT_MS` equals the outer value again.
3. Start a second close while the fake orca holds its first call; the test sets `ARK_ORCA_TIMEOUT_MS=600000` for this later gated child only.
4. Release the fake orca once the close is waiting.
5. Read the close output, the timeout variable the fake orca logged, and the variable in the test process.

## Expected results

- After step 2, the variable equals the outer value: the 300 ms override did not leak.
- The output contains `ctx_slow released (succeeded)` and no `orca:` line.
- The gated child ran with `ARK_ORCA_TIMEOUT_MS=600000`, far above any host stall, so only the release decides; it is not the 300 ms.
- After step 5, the variable in the test process equals the outer value again (the 600000 is restored).
- A host stall before the release does not fail the test.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
