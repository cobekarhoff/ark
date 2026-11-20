---
id: ARK-T703
title: ARK-T703 With no page the health route answers and shows no pass and no lag, the hub still reads nothing, and a pass dropped when the last page leaves is not recorded as a pass
level: integration
technique: state transition (no page, page, last page leaves while a pass is in flight)
priority: medium
risk: a lag timer or a pass timer that runs for the process life wakes an idle hub (ARK-365/ARK-442) or reports a lag of 0 as if it measured; or the route answers 404 or 500 with no page; or a pass dropped by the generation check (last page left) is recorded, so the health route shows an end time and duration for a read the page never saw
status: active
changed_by: 2026-11-19-ARK-533-1
---

## Objective

Prove the health route is safe with no page and records only passes that publish (ARK-533/AC2, ARK-365 contract). Expected: While no page is connected, the system shall answer the health route within 1 s, shall report no pass and no measured lag, and shall start no read; when the last page leaves during a pass, the system shall not record that pass.

Question 3: ARK-T240 and ARK-T241 own "an idle hub reads nothing" for the readers; they do not know the health route or a lag timer, and this case adds that the route does not change that. ARK-T700 owns the fields for a connected page. The dropped pass is the race the evaluation names (`read()` returns on a changed generation): two real processes, the hub and a client, with a fake `orca` held by a file as in ARK-T250.

## Preconditions

- Temp `ARK_HOME`, 3 runs, fake tools on `PATH`, `ARK_HUB_INTERVAL_MS=2000`. Real hub, port 0. The fake `orca` holds `terminal list` while the file `orca.hold` exists.
- The idle window of step 2 is real: a pass in an idle hub is shown absent only by observing longer than one interval. It is a loop of health requests ending on a monotonic deadline (`performance.now()` past `idleWindowMilliseconds` 2500, above the 2000 interval): the requests are the wait.
- The test file holds no `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)` (test/wallclock.test.ts, ARK-T126; the allowance cannot be raised). Every other wait is an event: a health-route poll, a fake-tool marker file or a stream read. The fake `orca` appends a line to `orca.done` when a `terminal list` call that waited on `orca.hold` ends. The validator runs `bun test test/wallclock.test.ts` before it finishes.
- The test sets its own timeout of 60 s.

## Steps

1. Start the hub. No page. `GET` the health route and time it.
2. Probe the health route back to back until the monotonic deadline `idleWindowMilliseconds` (2500) has passed since step 1. Read the fake `orca.log` call count, then `GET` the health route again.
3. Create `orca.hold`. Open `/events`. Poll the health route until `orca.log` holds a `terminal list` call and `orca.done` has no line (the pass is in flight and held), and until the health route shows a finite, non-null lag (the page is connected and the 100 ms lag timer has sampled; the poll is the wait for that first sample). Record the lag as present.
4. Close `/events` (the last page leaves). Poll the health route until its lag is absent again, with `orca.done` still empty: the lag was present while the page was connected (step 3), so its return to absent is the hub's acknowledgement of the disconnect (the lag measurement stops with the last page, step 1's contract, and `pause()` that advances `generation` runs in the same abort handler, `hub/server.ts:341-347`). A client-side close is not an acknowledgement; this transition is. Only then remove `orca.hold`.
5. Poll the health route until `orca.done` holds the line of the held call. Then probe the route back to back until a monotonic deadline of `settleMilliseconds` (1000) after that marker: the hub's continuation of the call (its pipe read, then `read()`) runs in that time, and the requests are the wait.
6. `GET` the health route once more.

## Expected results

- Step 1: status 200 and a request time at most `answerLimitMilliseconds` (1000); the lag is absent or null (not 0); every source has no duration and no end time; no source is named slow.
- Step 2: the `orca.log` call count is 0 before and after the wait (no read ran); the second answer equals the first.
- Step 3: the lag is finite and not null with the page connected while `orca.done` is empty (the transition in step 4 starts from a measured lag, not from a lag not yet sampled).
- Step 4: the lag goes from present to absent while the held call is still in flight (`orca.done` empty), so the release happens after the hub dropped the page; a hub whose lag never goes absent fails here, on the no-page contract.
- Steps 5 and 6: the `orca` source has no duration and no end time at every probe after the release (the dropped pass is not a pass: a correct hub drops it by `generation`, a hub that records it shows an end time); each answer is 200 and its measured request time is at most `answerLimitMilliseconds` (1000, a named constant, boolean compare).

## Screenshot checkpoints

none: JSON fields and fake tool logs only
