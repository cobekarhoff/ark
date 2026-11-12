---
id: ARK-T241
title: ARK-T241 With no page connected the hub runs no Orca, Plannotator or GitHub read, the first page gets fresh data within 5 s, and a quick disconnect and reconnect starts no second loop
level: integration
technique: state transition (idle, watched, idle) with boundary values (0 to 1 and 1 to 0 clients, reconnect in 50 ms)
priority: high
risk: the loops start at boot and never stop (about 4 external commands a second with no page); or a read in flight when the last page leaves publishes or re-arms its timer after the stop; or a quick reconnect starts a second loop per source so reads double
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove that an unwatched hub is idle and the first page wakes it. Serves ARK-365/AC2.

Expected: While no page is connected to `/events`, the hub shall run no Orca, Plannotator or GitHub read. The first page to connect shall get fresh data within 5 seconds.

## Preconditions

- A temporary `ARK_HOME` and a temporary git repo as the Ark repo, with a project and a run in `building`.
- Fake `orca`, `plannotator` and `gh` binaries first on `PATH`. Each appends one line to its own call-log file on every start and prints a fixed valid answer. A control file makes each one fail (exit 1) or change its answer.
- `ARK_HUB_INTERVAL_MS=100` so every source interval is 100 ms.
- The hub is started with `Bun.spawn` on port 0 and its port is read from its output.
- The run has an open plan gate (the gate event appended to its `events.ndjson`) and one merge request URL in its `state.json`, so Plannotator and GitHub have something to read. Fake `gh` answers `pr view` for that URL. (The `ark` source reads files and starts no binary, so it has no call log; its reads show through its `read_at`.)
- Fake `orca` also answers the Master Chief Run lookup (`run-list`) and `task-list` with a valid answer, so the queue source has a read to run: it reads on connect and makes no call while idle, which the zero-line checks prove.
- Fake `orca` answers at once, unless a hold file exists: then it waits in a loop until the hold file is removed, to leave a read in flight. The answer it prints comes from a control file, read when the answer is printed (after the hold ends), so the held read can return a different answer than the reads before it.

## Steps

1. Start the hub with no client. Wait 3 s. Count the lines in each call log and read `/api/snapshot` (it does not subscribe).
2. Connect a client to `/events`. Record the time until a push has the orca, plannotator and github `read_at` set later than the connection time. Note the log counts.
3. Count the lines of each log over a window of 2 s: N1 for each source.
4. Read `/api/snapshot` and record the orca terminals and `ok` (the old terminal set A, `ok: true`) and `read_at` (T0). Create the hold file and wait until fake orca has one more line (a read in flight). Disconnect the client. Set the control file so the held read will print a changed terminal set B (a new terminal, distinguishable from A). Read `/api/snapshot` and the log counts. Remove the hold file. Wait 3 s. Read the log counts and `/api/snapshot` again. Then repeat the whole step: reconnect, wait for fresh data, set the control file back to A, and this time set it so the held read exits 1 (an explicit failure) instead of printing B.
5. Connect a client, disconnect it, and reconnect within 50 ms, 5 times. Keep the last client. Count the lines of each log over a window of 2 s: N2 for each source.
6. Disconnect the last client. Wait for any read in flight to end (no hold file). Wait 3 s. Count the log lines.
7. Make fake `orca`, `plannotator` and `gh` exit 1. Connect a client. Record that the hub stays up, answers `/api/snapshot` and what the client gets.

## Expected results

- Step 1: 0 lines in each log, a `ps` check shows no child process of the hub.
- Step 2: fresh data for every source within 5 s of the connect.
- Step 3: N1 is at least 5 for each source (reads run at the interval) and below 25 (the interval is 100 ms, so about 20 at most).
- Step 4: after the release the log counts are the same as before the release (no timer is re-armed). Through `/api/snapshot`, which does not subscribe, orca still shows the old terminal set A and `ok: true`, never B and never `ok: false`, and `read_at` still equals T0. A hub that accepts the late result shows B (or `ok: false`) there, so the stale result is detected even though a same-answer read would leave the body unchanged.
- Step 5: after the churn N2 is below 1.5 times N1 for each source (a duplicate loop would be about 2 times N1) and at least 0.5 times N1.
- Step 6: 0 new log lines.
- Step 7: the hub stays up; orca, plannotator and github show `ok: false` (each has an eligible read: the open gate and the MR URL); the client gets a push.

## Screenshot checkpoints

none: process, call-log and event-stream assertions only
