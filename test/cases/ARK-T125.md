---
id: ARK-T125
title: ARK-T125 the provider-limits refresh test sets a short interval through one hub environment variable and sees the refresh at that interval, not at 60 seconds
level: integration
technique: equivalence classes of interval source (variable set to a short value, variable unset gives the 60 s default)
priority: high
risk: "the hub ignores the variable or reads it too late, so the test waits for the real 60 s interval again (61 s of the file); or the unset default changes and production polls at the wrong rate"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove (on a controlled clock, then on a live hub) that the hub's provider-limits refresh interval is set by one environment variable, so the ARK-285 refresh test sees a second snapshot within about a second, and that production keeps 60 s when the variable is unset.

Expected: Where the interval variable is set, the hub shall refresh the provider limits at that interval; where it is unset, at 60 seconds.

## Preconditions

- `hub/snapshot.ts` reads the variable at module load into the exported `intervalMilliseconds` table (the existing scheduling boundary; no test-only export); `test/hub-fixtures.ts` sets it in the hub's environment before spawn.

## Steps

1. Scheduling check (in-process, no real waiting): with the variable set to a short value (for example 500 ms), load `hub/snapshot.ts` and read the exported `intervalMilliseconds.providerLimits`; assert it equals the short value. Create the snapshot reader on a controlled clock (the runner's fake timers) with fake provider tools whose answer changes after the first read.
2. Advance the controlled clock by the short interval only; assert the snapshot now holds the changed limits.
3. Control: load the module again with the variable unset; advance the clock by the same short interval; assert the snapshot still holds the first limits. Then advance to 60 000 ms and assert the changed limits appear. A hub that ignores the variable fails step 2 or step 1.
4. Live check: start the hub with the variable set to a short value and fake provider tools that change their answer. Wait on the event (the changed limits in a snapshot), not on a sleep; no elapsed-time bound is asserted (the elapsed time goes in the AC9 report).
5. Assert the unset module value equals 60 000 ms.
6. Run `bun test test/hub.test.ts`.

## Expected results

- With the variable set, `intervalMilliseconds.providerLimits` is the short value and the changed limits appear after advancing the controlled clock by exactly that interval.
- With the variable unset, the same advance shows no change; the change appears only at 60 000 ms.
- The live hub with the variable set delivers the changed limits in a snapshot, with no sleep.
- `bun test test/hub.test.ts` exits 0.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
