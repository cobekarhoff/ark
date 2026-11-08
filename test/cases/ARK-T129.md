---
id: ARK-T129
title: ARK-T129 ARK-278-AC3 and the case beside it pass because the test releases the fake orca, and the 2-second reader timeout of cli/exec.ts cannot decide the result
level: integration
technique: fault injection (host stall past 2 s before the release); state release instead of timed answer
priority: high
risk: "the fake `orca` misses the 2 s reader timeout under host stall (1 in 76 runs), so the test fails by timing; or raising the timeout there also changes ARK-292-AC1 (the 300 ms case)"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that the fake `orca` answers only when the test releases it, and the timeout in that test is far above any stall, so the result no longer depends on the clock.

Expected: When the fake orca is released, the CLI shall read its answer and the test shall pass, whatever the delay before the release.

## Preconditions

- Helper at `test/run.test.ts` near line 866 gives a fake orca that waits on a release file or pipe.

## Steps

1. Start the CLI with the fake orca held.
2. Delay the release by 3 s (over the 2 s timeout) in a first run.
3. Release; assert the CLI reads the answer and the assertions of ARK-278-AC3 and its neighbour hold.
4. Run ARK-292-AC1 and `bun test test/timeouts.test.ts`: assert they pass unchanged (300 ms case still short; `loadProofPattern` still matches).
5. Run `bun test test/run.test.ts`.

## Expected results

- A 3 s delay before the release does not fail the test.
- ARK-292-AC1 and the timeouts test pass.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
