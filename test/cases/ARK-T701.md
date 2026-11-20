---
id: ARK-T701
title: ARK-T701 The hub logs one line for each pass longer than its interval and one for each loop lag above 1 s, naming the source and the duration, and no line for a normal pass or a lag below 1 s
level: integration
technique: equivalence classes (normal pass, slow pass) and boundary values (lag 0.3 s below, 1.5 s above 1 s)
priority: high
risk: a slow pass writes no line, or two lines, or one that does not name the source or the duration; or every pass logs (the `hub.log` of a healthy hub fills); or a short freeze is logged as a lag, or a long one is not; or the line is logged by a source that is not slow
status: active
changed_by: 2026-11-19-ARK-533-1
---

## Objective

Prove `hub.log` names each slow pass and each lag above 1 s, and stays silent otherwise (ARK-533/AC3). Expected: When a reader pass takes longer than its interval or the event loop lags more than 1 s, the system shall write one line with the source name and the duration, and when a pass is normal it shall write no line.

Question 3: the hub writes only its start line today. ARK-T700 owns the route; this case owns the log. The log cannot show a stall in progress (the line is written when the loop frees), which is why the case freezes the hub and reads the line after it continues.

## Waiting rule (test/wallclock.test.ts, ARK-T126)

The test file holds no `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)`, and the guard's allowance cannot be raised. Every wait is an event: a poll is a loop of health-route requests whose answer ends it (the requests are the wait), a stream read of the hub's output, or a process exit. A freeze is the fixture shell script beside the fake tools (`freeze.sh <pid> <seconds>`: `kill -STOP`, `sleep`, `kill -CONT`); the test awaits its exit and holds no delay. The hub's stdout and stderr are read by a stream reader that appends each chunk; the test reads the text collected so far after the poll event. Limits are named constants (`intervalMilliseconds` 4000, `orcaSleepSeconds` 6, `lagLineMilliseconds` 1000) compared with `toBeLessThanOrEqual`, `toBeGreaterThanOrEqual` or a boolean; durations in the log are checked against the lower bound only. The validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- Temp `ARK_HOME` and session folders, 3 runs, fake tools on `PATH`. The hub's stdout and stderr are both captured (launchd sends both to `hub.log`). The fake `orca` sleeps for the number of seconds in its `orca.sleep` state file (0 when absent) on `terminal list` only (the call that only the `orca` source makes, as the hold in `test/hub-idle.test.ts`), so no other source turns slow, and it appends a line to `orca.done` after its sleep ends.
- `ARK_READER_TIMEOUT_MS=30000` in every hub's environment: the reader default is 2000 ms (`cli/exec.ts` `readerTimeout`), so without it the 6 s call would be killed at 2 s, the pass would fail and a slow pass would not exist.
- `ARK_HUB_INTERVAL_MS=4000`: a normal pass (a few ms) is normal and a pass that calls the slow fake `orca` (`orcaSleepSeconds`, 6) is slow. The case waits for real passes (two slow passes in scenario B): one line per pass cannot be shown with one pass, and a slow pass cannot be forced faster than its interval.
- The test sets its own timeout of 90 s.
- The lines' format is not fixed by the AC. The validator pins it from the implementation once: a line names the source as a whole word and gives the duration in ms or s.

## Steps

Scenario A (normal passes, hub 1, `orca.sleep` absent):

1. Start hub 1, open `/events`. Poll the health route until `ark` and `usage` have ended two passes and every source has ended one. Read the output.

Scenario C (loop lag, same hub 1):

2. Run `freeze.sh <hub 1 pid> 0.3` and await its exit. Poll the health route until `ark` ends a pass again. Read the output.
3. Run `freeze.sh <hub 1 pid> 1.5` and await its exit. Poll until `ark` ends a pass again. Read the output. (1.5 s is below the 4 s interval, so no pass is slow: the freeze alone adds the line.)

Scenario B (slow pass, hub 2 on the same home, started only after hub 1 is gone):

4. Close `/events`, send SIGTERM to hub 1 by its pid and await its exit (the lock is released; a second hub of the same home and repository would refuse, ARK-T242). Write `orcaSleepSeconds` (6) into `orca.sleep`.
5. Start hub 2 with its own output capture, open `/events`. Poll the health route until `orca` has an end time. Read the output.
6. Poll until the `orca` end time advanced once more. Read the output.

## Expected results

- Step 1: the output holds the start line (`Ark hub on http://...`) and no other line.
- Step 2: no new line (a 0.3 s lag is below 1 s).
- Step 3: exactly one new line, naming a lag (the word `lag`) and a duration of at least 1000 ms; no new line names a source.
- Step 4: hub 1 exits.
- Step 5: exactly one line names `orca` with a duration of at least `orcaSleepSeconds` * 1000 ms, and `sources.orca.ok` in `/api/snapshot` is true (a completed slow call, not a timeout). No line names `ark`, `usage`, `plannotator` or `evidence` (their passes are normal).
- Step 6: exactly two lines name `orca`, one for each slow pass, each with its own duration.

## Screenshot checkpoints

none: process output only
