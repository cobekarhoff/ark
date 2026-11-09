---
id: ARK-T127
title: ARK-T127 ARK-277-AC6 ends its loop on the event, bounds the hub's CPU time to the full snapshot, and checks the p75 of 15 to 20 answers under 200 ms, with no wall-clock budget
level: integration
technique: boundary values on CPU limit (5 s limit, 1.5 s measured) and on the 75th percentile; fault injection of a host stall
priority: high
risk: "a host stall or load makes the test fail on elapsed wall time (1 in 73 runs; 7189 ms against 5000), or the CPU budget and p75 let a real slowdown of the hub pass"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that the hub's full-snapshot work and answer speed are checked by CPU time used and by the p75 of the answers, so a stalled host does not fail the test but a slower hub still does.

Expected: The hub shall use no more than 5 s of CPU time up to the full snapshot, and the p75 of 15 to 20 answers shall be under 200 ms.

## Preconditions

- Hub spawned by the fixtures; one portable CPU-time source (the hub child's resource usage), the same on macOS and Linux.

## Steps

1. Read ARK-277-AC6: assert it holds no `Date.now()` or `performance.now()` budget compared to 5000 and that its wait loop ends on the snapshot event.
2. Run it: assert the measured CPU time is under 5 s (about 1.5 s) and the p75 of the answers is under 200 ms.
3. Inject a sleep of 6 s in the test process before the final read: assert the test still passes.
4. Inject CPU work in the hub (a busy loop of 6 s in the snapshot code in a scratch copy): assert the test fails on the CPU budget.
5. Run `bun test test/hub.test.ts`.

## Expected results

- No wall-clock budget remains and the loop ends on the event.
- Stall passes; real CPU work in the hub fails.
- The test passes.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
