---
id: ARK-T700
title: ARK-T700 The health route answers within 1 s with loop lag (the largest of the last minute) and, for each reader source, last pass duration and end time, and names a source whose last pass took longer than its interval
level: integration
technique: equivalence classes (normal pass, slow pass, recovered pass), state transition (frozen then continued process) and boundary values (a lag sample inside and outside the 60 s window)
priority: high
risk: the route waits on the snapshot or `reader.ready()` and stalls with the hub; or the lag is a constant 0, the latest sample or a lifetime maximum, so a frozen loop reads 0, a lag seen a moment ago is forgotten, or a lag that happened an hour ago is still reported; or the slow flag compares the wrong pair (duration against the 5 s stall limit, or a fixed number) or sticks after a source recovers; or the route sits before the `isLocalRequest` check and answers a foreign Origin
status: active
changed_by: 2026-11-19-ARK-533-1
---

## Objective

Prove the health route reports real loop lag and per-source pass timing, and names slow sources by their own interval (ARK-533/AC2). Expected: When a client asks the health route, the system shall answer within 1 s with the event loop lag (the largest delay over the last minute) and, for each reader source, the duration of its last pass and the time it ended, and shall name as slow a source whose last pass took longer than its interval.

Question 3: no route or test reads pass timing today; the route does not exist. ARK-T699 only uses the route's lag as a measurement and a soak never introduces a known lag, so it cannot prove the window. This case owns what the fields mean, including that a known lag stays as the maximum and then expires. The no-page and dropped-pass states are owned by ARK-T703.

The route is named `/api/health` here; if the implementation picks another path, the validator reads it from the `serve` doc comment of `hub/server.ts`.

## Waiting rule (test/wallclock.test.ts, ARK-T126)

The test file holds no `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)`, and the guard's allowance cannot be raised. Every wait is an event: a poll is a loop of health-route requests whose answer or whose fake-tool marker file ends it (the requests are the wait, never a sleep), a stream read, or a process exit. The 1.5 s freeze is a fixture shell script beside the fake tools (`freeze.sh <pid> <seconds>`: `kill -STOP`, `sleep`, `kill -CONT`); the test awaits its exit, as it awaits the slow fake `orca`, and holds no delay itself. Limits are named constants (`answerLimitMilliseconds` 1000, `intervalMilliseconds` 4000, `orcaSleepSeconds` 6, `freezeSeconds` 1.5, `windowMilliseconds` 60000) compared with `toBeLessThanOrEqual`, `toBeGreaterThanOrEqual` or a boolean. A bound on the hub's speed is checked on what the hub reports (the pass duration, the lag) or on a measured request time, and an upper bound that a loaded host could break is replaced by the hub's own slow flag. The validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- Temp `ARK_HOME` and temp session folders, 3 runs, fake `orca`, `gh`, `omp`, `plannotator` on `PATH`. The fake `orca` sleeps `orcaSleepSeconds` (6) on `terminal list` only (the call that only the `orca` source makes, as the hold in `test/hub-idle.test.ts`), so no other source turns slow, and it appends a line to `orca.done` after its sleep ends.
- `ARK_READER_TIMEOUT_MS=30000` in the hub's environment: the reader default is 2000 ms (`cli/exec.ts` `readerTimeout`), so without it the 6 s call would be killed at 2 s and the pass would fail, not run long. The headroom is five times the forced delay.
- Real `bun hub/main.ts --port 0` with `ARK_HUB_INTERVAL_MS=4000`: a normal pass (a few ms) is far below its interval, and the `orca` pass (6 s) is above it. A slow pass cannot be forced faster than its interval, and a lag of 1 s needs a loop that stood still for more than 1 s.
- The test sets its own timeout of 150 s: the lag window is 60 s and the case waits for its expiry (step 7).

## Steps

1. Start the hub. Open `GET /events` and hold it.
2. While the first `orca` pass is in flight (the fake `orca.log` has a `terminal list` call and `orca.done` has none), time `GET` of the health route. Poll with health requests until that marker is seen.
3. Poll the route until the `orca` source has an end time. Read the whole answer, and `GET /api/snapshot` for `sources.orca.ok`.
4. Rewrite the fake state so `terminal list` answers at once. Poll until the `orca` end time advanced. Read the answer.
5. Run `freeze.sh <hub pid> 1.5` and await its exit. Read the route as soon as it answers; keep that lag as `frozenLag` and the exit time as `freezeEndedAt` (`performance.now()`).
6. Poll until the `ark` source ends a pass again (the latest lag samples are small now). Read the route.
7. Poll the route back to back until the lag is below `frozenLag`, or the case timeout. Keep the elapsed time since `freezeEndedAt` at the first such answer.
8. `GET` the route and `GET /api/snapshot` with `Origin: http://evil.example`.

## Expected results

- Step 2: status 200 and a measured request time at most `answerLimitMilliseconds` (the route does not wait for the pass in flight).
- Step 3: the lag is a finite number of ms; `orca` has a duration of at least `orcaSleepSeconds` * 1000 ms, an end time (ISO or epoch) between the test's start and now, and is named slow. `sources.orca.ok` is true and `orca.done` has the line of every delayed call: the pass ran long, it did not time out. `usage`, `ark`, `plannotator` and `evidence` are not named slow and have a duration and an end time. Every source of `SourceName` has an entry.
- Step 4: `orca` has a duration at most `intervalMilliseconds` and is no longer named slow (the flag follows the last pass).
- Step 5: the lag is at least 1000 ms (the freeze lasted 1500), and the route answered with status 200.
- Step 6: the lag is still at least 1000 ms and equals `frozenLag`: the route reports the maximum of the window, not the latest sample, and a 100 ms timer that reads 0 again does not hide it.
- Step 7: the lag drops below `frozenLag`, so the last delayed sample expires; the elapsed time since `freezeEndedAt` is at least `windowMilliseconds` minus 5000 ms (an expiry earlier than the minute means a shorter window), and an answer below `frozenLag` exists before the case timeout (a lifetime maximum never drops). The elapsed time has no upper bound but the case timeout.
- Step 8: the health route returns the same status as `/api/snapshot` with that Origin (refused), not 200.

## Screenshot checkpoints

none: JSON fields and HTTP status only
