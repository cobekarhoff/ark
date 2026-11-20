---
id: ARK-T699
title: ARK-T699 With a page connected, default reader intervals and 250 runs plus 4000 session files, every route answers within 1 s at every probe for 120 s and the loop never lags over 200 ms
level: integration
technique: soak under load (every route probed back to back) and boundary values (1 s answer, 200 ms lag)
priority: high
risk: a reader pass (usage `#refresh` stat of every session file, `compose()` re-scanning sessions per publish, the Ark reader's per-run stats) runs synchronously for seconds on a large home, so GET / and every /api route wait 7 to 50 s while a page is connected; or a fix that bounds a pass does it by dropping data, so the usage total shown is smaller than the files hold
status: active
changed_by: 2026-11-20-ARK-602-1
---

## Objective

Prove the hub stays responsive on a home the size of the incident (ARK-533/AC1). Expected: While a page holds an `/events` stream and the readers run at their default intervals on 250 runs and 4000 session files, the system shall answer `GET /` and every `GET /api` route within 1 s at every probe for 120 s, and no reader pass shall hold the event loop for more than 200 ms.

Question 3 (why existing proof misses it): every existing hub test sets `ARK_HUB_INTERVAL_MS` to 100 to 300 ms on a handful of runs, so none runs the default intervals on a large home. This case is the only owner of "responsive on a large home" and of "every route answers" on it. The health route's own fields are owned by ARK-T700; this case only reads its lag and end times.

## Waiting rule (test/wallclock.test.ts, ARK-T126)

The new test file holds no `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)`, and the guard's allowance cannot be raised. The only wait is the probe loop itself: it ends on a monotonic deadline (`performance.now()` past 120 s), because the requests are the wait. No per-request abort timer: a hang is caught by the case timeout. The 1 s and 200 ms limits are named constants (`answerLimitMilliseconds`, `lagLimitMilliseconds`) compared with `toBeLessThanOrEqual` or a boolean. The 1 s bound is checked on the measured request durations; the 200 ms bound on the lag the hub reports. The validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- A temp `ARK_HOME`, temp `ARK_OMP_SESSIONS`, `ARK_CLAUDE_SESSIONS` and `ARK_CODEX_SESSIONS` (the hub reads nothing of the real home). Fixture built with sync writes in the test process, in under 10 s: 250 runs with `writeRun` (40 `building` with a worktree path, 210 closed, each with its events), and 4000 session files made with `ompSessionText` in 250 sub-folders (16 files each), 40 of them with a `cwd` inside an open run's worktree and the rest in other folders. Every message has a fixed cost, so the expected usage total is known.
- One fixture-backed target for each parameterised route, built as the existing route tests of `test/hub.test.ts` build them, on one open run and one ticket: a ticket document and a test case under the project's `tickets/` and `test/cases/`; a session transcript of the open run's agent with one tool call and its result; a run file (`ticket.md`); a PNG under `results/evidence/`; a plan with a case result for the evidence route; a handle directory so the conversation routes answer `ready` and hold at least one message with a body.
- Fake `orca`, `gh`, `omp` and `plannotator` on `PATH` that answer at once (the `test/hub-idle.test.ts` fixture), and `ARK_READER_TIMEOUT_MS=30000` in the hub's environment (a loaded host does not turn a slow tool into a failed pass).
- A real `bun hub/main.ts --port 0` with `ARK_HUB_INTERVAL_MS` and `ARK_PROVIDER_LIMITS_MS` deleted from its environment: the default intervals (2 to 60 s) apply.
- The test sets its own timeout of 150 s. The 120 s is the window the AC names: it holds at least two passes of every source, including `providerLimits` (60 s); a shorter window never reads a second pass of the slow sources.

## Steps

1. Start the hub; read its port. Open `GET /events` (Server-Sent Events) and hold it, reading pushes, until the end of the case; note the first push that holds the runs (the first snapshot of the page, an event wait on the stream read, never a timer). Do not wait for it: request 1 of step 2 leaves right after the stream opens, on a cold hub. Why: a direct or reloaded run URL renders Run with no snapshot gate and asks for `GET /api/run/<run>` at once, so a cold first read (about 2 s on a 4-core CI runner, up to about 7 s on the real home) is inside AC1's "every probe".
2. Until the 120 s deadline, one request at a time, back to back, in a fixed order: `GET /`, `GET /assets/<one built asset>`, and every GET route of the `serve` comment in `hub/server.ts` with a valid request: `/api/snapshot`, `/api/resources/history`, `/api/companions`, the health route of ARK-T700, `/api/conversation?since=&until=`, `/api/conversation/message/<id>` (id read from the run conversation answer), `/api/run/<open run>`, `/api/run/<closed run>`, `/api/run/<open run>/conversation`, `/api/run/<open run>/transcript?file=&cursor=`, `/api/run/<open run>/transcript/result?file=&call=`, `/api/run/<open run>/file?path=ticket.md`, `/api/run/<open run>/evidence`, `/api/run/<open run>/image?path=`, `/api/ticket/<project>/<ticket>`, `/api/ticket/<project>/<ticket>/cases`; and `POST /api/open-in-orca` with the page's own Origin (fake `orca` answers at once). Record route, status and duration; keep the largest duration of each route and a count, not every sample.
3. At every health probe keep the whole answer with its probe time into the soak (`lag_ms` and every source's `last_ms` and `ended_at`; the health lag is a 60 s window, so every probe is kept, not only the largest lag), and keep the hub output (`hub.output()`) with the time each line was read. The largest lag is the maximum `lag_ms`; the first probe that reported it fixes the window (see ARK-T730).
4. At the first and at the last health probe keep each source's last pass end time.
5. After the deadline, read `/api/snapshot` and compare its usage total with the fixture's known total. Stop the hub with SIGTERM and await its exit.
6. Page (Playwright, `test/pw/hub.pw.ts`, title starts `ARK-T699`): on a hub with one closed run, open the direct run URL `#/run/<run>` in a fresh page. The test answers the first three `GET /api/run/<run>` with 503 `loading` (the cold hub's answer; one ask can come from the first usage read changing the page's key, so the third 503 needs a retry) and holds the fourth ask until the page has shown its state; then it releases it to the hub.

## Expected results

- Step 2: every request returns the status the route has for a valid request (200; 200 for the POST), and the largest duration of every route is at most `answerLimitMilliseconds` (1000). The failure message names the route and its largest duration. Every route in the list answered at least once. The one other status allowed is 503 with a body that starts with `loading`, only for a request that left before the first snapshot was published: it is the cold hub's answer and still has to arrive within 1 s. A 503 for a request that left after the first snapshot, and a 200 later than 1 s, fail.
- Step 3: the largest lag seen is at most `lagLimitMilliseconds` (200), as reported by the hub; the limit stays 200 and the test never raises it. When it is above, the failure message names the work of the window of the largest lag, as the helper of ARK-T730 builds it: the lag, its time into the soak, each source whose pass ended or ran in the window (name, duration, end time from `/api/health`) and each hub line of the window, or "no source" and "no hub line". ARK-T730 owns the window rule and the text; this case owns that the soak records every probe, passes them to the helper, and still asserts `lag <= lagLimitMilliseconds`. The soak is never made to fail to show the message.
- Step 4: the end time of every source is later at the last probe than at the first (the readers keep running; speed was not bought by stopping them); `providerLimits` and `github` ended at least once.
- Step 5: the usage total equals the fixture's known total, or the usage source reports unknown or stale. It is never a smaller number.
- Step 6: after the 503s the page asks again (a fourth ask arrives), shows `Reading the run…` and no "could not read run" text while it waits, and then shows the run (its file links). A 503 `loading` is a loading state, not a failure.

Not probed, with the reason: `POST /api/companions/approve|dismiss|ask` change the proposed-ticket files and run `ark companion ask`; they are page-driven writes, not reads the readers' passes can delay, and the soak's fixture must stay fixed. Their own cases own them.

Red on unfixed code: step 2 shows a route above 1 s (the stopgap evidence is 7 s at the first pass with 30 s intervals, 46 to 50 s with the defaults) and step 3 fails on the missing health route. If the 4000-file fixture does not push a probe above 1 s on the unfixed code, the validator enlarges the fixture (more messages per file, more runs with files) and records the base result in `results/evidence/ARK-T699/base/`; it never loosens an assertion.

## Screenshot checkpoints

Step 6 only: `reading-after-503` (the page waits, no failure text) and `run-shown-after-retry` (the run is shown). Steps 1 to 5: none, HTTP durations and JSON fields only.
