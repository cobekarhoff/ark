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
3. Before step 2 starts, read `Date.now()` and `performance.now()` together: `soakStartEpoch` and `soakStart`. After every `GET /api/health` answer keep the whole answer as a probe with its time `performance.now() - soakStart` (ms into the soak, never measured from the deadline): `lag_ms` and every source's `last_ms`, `ended_at` (the ISO string the route sends) and `slow`. The health lag is a 60 s window, so every probe is kept, not only the largest lag. Read `hub.output()` right after each health probe too: the text added since the previous read is split into lines, and each new line is stamped with that probe's time into the soak. The output is never read once after the deadline. The largest lag is the maximum `lag_ms`.
4. After the loop, build the message with the helper of ARK-T730 (`test/hub-stall-window.ts`) from every kept probe, every stamped line and `soakStartEpoch`, on every run, and use it as the failure message of the lag assert.
5. At the first and at the last health probe keep each source's last pass end time.
6. After the deadline, read `/api/snapshot` and compare its usage total with the fixture's known total. Stop the hub with SIGTERM and await its exit.
7. Page (Playwright, `test/pw/hub.pw.ts`, title starts `ARK-T699`): on a hub with one closed run, open the direct run URL `#/run/<run>` in a fresh page. The test answers the first three `GET /api/run/<run>` with 503 `loading` (the cold hub's answer; one ask can come from the first usage read changing the page's key, so the third 503 needs a retry) and holds the fourth ask until the page has shown its state; then it releases it to the hub.

## Expected results

- Step 2: every request returns the status the route has for a valid request (200; 200 for the POST), and the largest duration of every route is at most `answerLimitMilliseconds` (1000). The failure message names the route and its largest duration. Every route in the list answered at least once. The one other status allowed is 503 with a body that starts with `loading`, only for a request that left before the first snapshot was published: it is the cold hub's answer and still has to arrive within 1 s. A 503 for a request that left after the first snapshot, and a 200 later than 1 s, fail.
- Step 3: the largest lag seen is at most `lagLimitMilliseconds` (200), as reported by the hub; the limit stays 200 and the test never raises it. The assert stays `lag <= lagLimitMilliseconds`.
- Step 4: on every run, passing or not, the soak builds the message from the probes it recorded and asserts that the message holds `largestLag` (or says there was no lag when every `lag_ms` is 0 or `null`), that the number of probes it passes to the helper equals the number of `GET /api/health` requests it sent, that the probe times never decrease with the probe order, and that the time of the probe that holds `largestLag` is at least 0 and at most the soak's elapsed time read after the loop (about 120000). A soak that passes only the probe with the largest lag fails the count; one that measures time from the deadline fails the order. The message is the failure text of the lag assert; when the lag is above 200 it names the work of the window of the largest lag, as ARK-T730 defines it (the lag, its time into the soak, each source whose pass ended or ran in the window with name, duration and end time from `/api/health`, each hub line of the window, or "no source" and "no hub line"). ARK-T730 owns the window rule and the text. The soak is never made to fail to show the message.
- Step 5: the end time of every source is later at the last probe than at the first (the readers keep running; speed was not bought by stopping them); `providerLimits` and `github` ended at least once.
- Step 6: the usage total equals the fixture's known total, or the usage source reports unknown or stale. It is never a smaller number.
- Step 7: after the 503s the page asks again (a fourth ask arrives), shows `Reading the run…` and no "could not read run" text while it waits, and then shows the run (its file links). A 503 `loading` is a loading state, not a failure.

Not probed, with the reason: `POST /api/companions/approve|dismiss|ask` change the proposed-ticket files and run `ark companion ask`; they are page-driven writes, not reads the readers' passes can delay, and the soak's fixture must stay fixed. Their own cases own them.

Red on unfixed code: step 2 shows a route above 1 s (the stopgap evidence is 7 s at the first pass with 30 s intervals, 46 to 50 s with the defaults) and step 3 fails on the missing health route. If the 4000-file fixture does not push a probe above 1 s on the unfixed code, the validator enlarges the fixture (more messages per file, more runs with files) and records the base result in `results/evidence/ARK-T699/base/`; it never loosens an assertion. At the base of run 2026-11-20-ARK-602-1 (the health route exists, the soak keeps only the largest lag and its deadline-based time) step 4 fails because `test/hub-stall-window.ts` does not exist; it passes on a healthy host once the soak feeds the helper every probe.

## Screenshot checkpoints

Step 7 only: `reading-after-503` (the page waits, no failure text) and `run-shown-after-retry` (the run is shown). Steps 1 to 6: none, HTTP durations and JSON fields only.
