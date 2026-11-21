---
id: ARK-T241
title: ARK-T241 With no page connected the hub runs no Orca, Plannotator or GitHub read, the first page gets fresh data within 5 s, and a quick disconnect and reconnect starts no second loop
level: integration
technique: state transition (idle, watched, idle) with boundary values (0 to 1 and 1 to 0 clients, reconnect in 50 ms)
priority: high
risk: the loops start at boot and never stop (about 4 external commands a second with no page); or a read in flight when the last page leaves publishes or re-arms its timer after the stop; or a quick reconnect starts a second loop per source so reads double; or the churn limit comes from one window that a loaded host starved, so a healthy hub fails (ARK-615)
status: active
changed_by: 2026-11-20-ARK-615-1
---

## Objective

Prove that an unwatched hub is idle and the first page wakes it. Serves ARK-365/AC2. Also owns the idle lifecycle of the full conversation inbox read (`orca orchestration inbox --json --full --limit <N>`, ARK-344): it is one more Orca source that shall not run with no page and shall not double on reconnect.

Expected: While no page is connected to `/events`, the hub shall run no Orca, Plannotator or GitHub read. The first page to connect shall get fresh data within 5 seconds.

ARK-615 changes the read-rate rule of steps 3 and 5 (ARK-615/AC1, AC2): the baseline is the largest of three consecutive 2 s windows, the churn window stays below 1.5 times it for every source, with no lower bound and no floor of 5 reads. Authoring gate for that change:

1. Protects: a quick disconnect and reconnect leaves one read loop per source, judged against a baseline that one starved window cannot set.
2. Fails when: the hub starts a second loop on reconnect (about 40 reads against a limit of about 30 on a host with no load; a host that starves the churn window to half can hide it, which the ticket accepts), or a window exceeds 25 (a second loop from the first connect); and on the base, a starved first window fails the floor of 5 or the 1.5 limit (runs 2026-11-20-ARK-608-1 and 2026-11-20-ARK-606-1).
3. Existing proof: this case owns the rule; ARK-T756 owns the starved first window made on demand with the hold controls, through the same window-check module.
4. No hook in `hub/`: the window check is a test module under `test/`.

## Preconditions

- A temporary `ARK_HOME` and a temporary git repo as the Ark repo, with a project and a run in `building`.
- Fake `orca`, `plannotator` and `gh` binaries first on `PATH`. Each appends one line to its own call-log file on every start and prints a fixed valid answer. A control file makes each one fail (exit 1) or change its answer.
- `ARK_HUB_INTERVAL_MS=100` so every source interval is 100 ms.
- The hub is started with `Bun.spawn` on port 0 and its port is read from its output.
- The run has an open plan gate (the gate event appended to its `events.ndjson`) and one merge request URL in its `state.json`, so Plannotator and GitHub have something to read. Fake `gh` answers `pr view` for that URL. (The `ark` source reads files and starts no binary, so it has no call log; its reads show through its `read_at`.)
- Fake `orca` also answers the Master Chief Run lookup (`run-list`) and `task-list` with a valid answer, so the queue source has a read to run: it reads on connect and makes no call while idle, which the zero-line checks prove.
- Fake `orca` also answers `inbox --json --full --limit <N>` with a valid message list; its calls are counted in the orca log as the lines whose arguments hold `--full` (the liveness read `--limit 200 --full` is counted with the others, so count the conversation read by its larger `--limit`).
- Fake `orca` answers at once, unless a hold file exists: then it waits in a loop until the hold file is removed, to leave a read in flight. The answer it prints comes from a control file, read when the answer is printed (after the hold ends), so the held read can return a different answer than the reads before it. `orca.hold` holds only `terminal list`. The other hold controls of `fixture()` (`plannotator.hold`, `inbox.hold`, `gh.hold`, see ARK-T756) stay off in this case: with no hold file no fake waits.
- The window check is a module under `test/` that this case and ARK-T756 load with `await import`. It takes three window counts and the churn window count of each source and fails with a message that names the source, the three window counts and the churn count.

## Steps

1. Start the hub with no client. Wait 1.5 s. Count the lines in each call log and read `/api/snapshot` (it does not subscribe).
2. Connect a client to `/events`. Record the time until a push has the orca, plannotator and github `read_at` set later than the connection time. Note the log counts.
3. Count the lines of each log over three consecutive windows of 2 s: W1, W2 and W3 for each of the five sources (orca `terminal list`, plannotator, gh, the conversation `inbox` read, the Master Chief unread `inbox --terminal` read). The baseline N1 of a source is the largest of its three counts.
4. Read `/api/snapshot` and record the orca terminals and `ok` (the old terminal set A, `ok: true`) and `read_at` (T0). Create the hold file and wait until fake orca has one more line (a read in flight). Disconnect the client. Set the control file so the held read will print a changed terminal set B (a new terminal, distinguishable from A). Wait 200 ms (the hub sees the disconnect). Read `/api/snapshot` and the log counts. Remove the hold file. Wait 1.5 s. Read the log counts and `/api/snapshot` again. Then repeat the whole step: reconnect, wait for fresh data, set the control file back to A, and this time set it so the held read exits 1 (an explicit failure) instead of printing B.
5. Connect a client, disconnect it, and reconnect within 50 ms, 5 times. Keep the last client. Count the lines of each log over a window of 2 s: N2 for each source. Run the window check on W1, W2, W3 and N2 of each source.
6. Disconnect the last client. Wait 500 ms for any read in flight to end (no hold file). Count the log lines. Wait 1.5 s. Count the log lines again.
7. Make fake `orca`, `plannotator` and `gh` exit 1. Connect a client. Record that the hub stays up, answers `/api/snapshot` and what the client gets.

## Expected results

- Step 1: 0 lines in each log, a `ps` check shows no child process of the hub.
- Step 2: fresh data for every source within 5 s of the connect.
- Step 3: each of W1, W2 and W3 is below 25 for each source (the interval is 100 ms, so about 20 at most). No window has a floor: a window starved by a loaded host to 3 reads is not a failure.
- Step 4: after the release the log counts are the same as before the release (no timer is re-armed). Through `/api/snapshot`, which does not subscribe, orca still shows the old terminal set A and `ok: true`, never B and never `ok: false`, and `read_at` still equals T0. A hub that accepts the late result shows B (or `ok: false`) there, so the stale result is detected even though a same-answer read would leave the body unchanged.
- Step 5: after the churn N2 is below 1.5 times N1 for each source (a duplicate loop would be about 2 times N1). No lower bound applies to N2. A source with 0 in all three windows fails here (no count is below 0), so every source, the conversation read included, must read while a page is connected. A failure names the source and prints W1, W2, W3 and N2.
- Step 6: 0 new log lines between the two counts, including no `inbox` call with the conversation `--limit`.
- Step 7: the hub stays up; orca, plannotator and github show `ok: false` (each has an eligible read: the open gate and the MR URL); the client gets a push.

## Screenshot checkpoints

none: process, call-log and event-stream assertions only
