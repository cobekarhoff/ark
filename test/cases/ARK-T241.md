---
id: ARK-T241
title: ARK-T241 With no page connected the hub runs no Orca, Plannotator or GitHub read, the first page gets fresh data within 5 s, and a quick disconnect and reconnect starts no second loop
level: integration
technique: state transition (idle, watched, idle) with boundary values (0 to 1 and 1 to 0 clients, reconnect in 50 ms)
priority: high
risk: the loops start at boot and never stop (about 4 external commands a second with no page); or a read in flight when the last page leaves publishes or re-arms its timer after the stop; or a quick reconnect starts a second loop per source so reads double; or the churn limit comes from one window that a loaded host starved, so a healthy hub fails (ARK-615); or the churn limit is so tight that the 1 to 4 reads a window of a healthy Linux runner fail it (ARK-631); or step 6 takes its settled count at a fixed time, before a read in flight at the disconnect has logged its last call, so a loaded host fails a healthy hub (ARK-631, `Expected 803, Received 804`)
status: active
changed_by: 2026-11-21-ARK-631-1
---

## Objective

Prove that an unwatched hub is idle and the first page wakes it. Serves ARK-365/AC2. Also owns the idle lifecycle of the full conversation inbox read (`orca orchestration inbox --json --full --limit <N>`, ARK-344): it is one more Orca source that shall not run with no page and shall not double on reconnect.

Expected: While no page is connected to `/events`, the hub shall run no Orca, Plannotator or GitHub read. The first page to connect shall get fresh data within 5 seconds.

ARK-615 set the baseline of steps 3 and 5: the largest of three consecutive 2 s windows, with no lower bound and no floor of 5 reads. ARK-631 changes the limit (ARK-631/AC1, AC2): the churn count of each source stays below 4 times its baseline, and the sum of the churn counts stays below 1.5 times the sum of the baselines. ARK-631 also changes step 6 (ARK-631/AC3): a bounded wait until the call count stops changing replaces the fixed 500 ms wait. Authoring gate for the ARK-631 change:

1. Protects: a quick disconnect and reconnect leaves one read loop per source, judged by a rule that a healthy runner's small counts pass; and no read runs after the last page leaves, judged after the read in flight at the disconnect has ended, however long it takes within the bound.
2. Fails when: the hub starts a second loop on reconnect (every source about 2 times its baseline: the churn sum is about 2 times the sum of the baselines, against a limit of 1.5 times), or a window exceeds 25 (a second loop from the first connect); or the hub keeps reading after the last page leaves (the count never settles, and the wait fails at its bound; step 8 owns that failure on a counter that never settles, because no seam in `hub/` makes the hub start a read after the disconnect). On the base, step 6 fails when the read in flight ends 700 ms after the disconnect (the fixed 500 ms wait takes the count before the held pass logs its `worker-list` and `task-list` calls).
3. Existing proof: ARK-T777 owns the window rule on the exact CI counts; this case owns its use on a live hub and the idle lifecycle; ARK-T756 owns the starved first window made on demand, through the same window-check module. Step 4 owns a read in flight that re-arms its timer once (it counts from before the release); step 6 owns a loop that keeps running after the last page leaves.
4. No hook in `hub/`: the window check and the settle wait live in `test/`; the read in flight is the existing `orca.hold` control of the fake.

## Preconditions

- A temporary `ARK_HOME` and a temporary git repo as the Ark repo, with a project and a run in `building`.
- Fake `orca`, `plannotator` and `gh` binaries first on `PATH`. Each appends one line to its own call-log file on every start and prints a fixed valid answer. A control file makes each one fail (exit 1) or change its answer.
- `ARK_HUB_INTERVAL_MS=100` so every source interval is 100 ms.
- The hub is started with `Bun.spawn` on port 0 and its port is read from its output.
- The run has an open plan gate (the gate event appended to its `events.ndjson`) and one merge request URL in its `state.json`, so Plannotator and GitHub have something to read. Fake `gh` answers `pr view` for that URL. (The `ark` source reads files and starts no binary, so it has no call log; its reads show through its `read_at`.)
- Fake `orca` also answers the Master Chief Run lookup (`run-list`) and `task-list` with a valid answer, so the queue source has a read to run: it reads on connect and makes no call while idle, which the zero-line checks prove.
- Fake `orca` also answers `inbox --json --full --limit <N>` with a valid message list; its calls are counted in the orca log as the lines whose arguments hold `--full` (the liveness read `--limit 200 --full` is counted with the others, so count the conversation read by its larger `--limit`).
- Fake `orca` answers at once, unless a hold file exists: then it waits in a loop until the hold file is removed, to leave a read in flight. The answer it prints comes from a control file, read when the answer is printed (after the hold ends), so the held read can return a different answer than the reads before it. `orca.hold` holds only `terminal list`. The other hold controls of `fixture()` (`plannotator.hold`, `inbox.hold`, `gh.hold`, see ARK-T756) stay off in this case: with no hold file no fake waits.
- The window check is a module under `test/` that this case, ARK-T756 and ARK-T777 load. It takes three window counts and the churn window count of each source, and fails with a message that names the counts it judged: the source and its three window counts, churn count and limit for a per-source failure, every source's counts and the two sums for a sum failure.
- The settle wait of step 6 polls a count function. It returns once the count has stayed the same over a quiet span of 2.5 s (a loaded host starts the second-stage calls of the held pass up to about 2.2 s after the release), and fails with the counts it sampled when it has not settled 10 s after it starts. Step 6 starts it when it releases the hold, so the whole quiet span and the whole bound follow the end of the read in flight: counted from the disconnect, 700 ms of the span would pass inside the hold, where the count is flat. The count is the call-log lines of the fakes only: the Ark read and its watch worker (ARK-613, whose watchers open before the first push) start no fake binary, so the wait neither counts them nor waits for them.

## Steps

1. Start the hub with no client. Wait 1.5 s. Count the lines in each call log and read `/api/snapshot` (it does not subscribe).
2. Connect a client to `/events`. Record the time until a push has the orca, plannotator and github `read_at` set later than the connection time. Note the log counts.
3. Count the lines of each log over three consecutive windows of 2 s: W1, W2 and W3 for each of the five sources (orca `terminal list`, plannotator, gh, the conversation `inbox` read, the Master Chief unread `inbox --terminal` read). The baseline N1 of a source is the largest of its three counts.
4. Read `/api/snapshot` and record the orca terminals and `ok` (the old terminal set A, `ok: true`) and `read_at` (T0). Create the hold file and wait until fake orca has one more line (a read in flight). Disconnect the client. Set the control file so the held read will print a changed terminal set B (a new terminal, distinguishable from A). Wait 200 ms (the hub sees the disconnect). Read `/api/snapshot` and the log counts. Remove the hold file. Wait 1.5 s. Read the log counts and `/api/snapshot` again. Then repeat the whole step: reconnect, wait for fresh data, set the control file back to A, and this time set it so the held read exits 1 (an explicit failure) instead of printing B.
5. Connect a client, disconnect it, and reconnect within 50 ms, 5 times. Keep the last client. Count the lines of each log over a window of 2 s: N2 for each source. Run the window check on W1, W2, W3 and N2 of each source.
6. Create `orca.hold` and wait until fake orca logs one more `terminal list` line (a read in flight). Disconnect the last client. Remove the hold file 700 ms after the disconnect, so the read in flight ends then. Right after the release, start the settle wait on the count of every call-log line (every orca call, plannotator and gh). At the settle wait's return, take that count and the conversation and chiefUnread counts. Wait 1.5 s. Count the log lines again.
7. Make fake `orca`, `plannotator` and `gh` exit 1. Connect a client. Record that the hub stays up, answers `/api/snapshot` and what the client gets.
8. Unit step, in `test/hub-window-check.test.ts` (no hub): call the settle wait with a count function that returns a new value on every call, a quiet span of 100 ms and a bound of 400 ms.

## Expected results

- Step 1: 0 lines in each log, a `ps` check shows no child process of the hub.
- Step 2: fresh data for every source within 5 s of the connect.
- Step 3: each of W1, W2 and W3 is below 25 for each source (the interval is 100 ms, so about 20 at most). No window has a floor: a window starved by a loaded host to 3 reads is not a failure.
- Step 4: after the release the log counts are the same as before the release (no timer is re-armed). Through `/api/snapshot`, which does not subscribe, orca still shows the old terminal set A and `ok: true`, never B and never `ok: false`, and `read_at` still equals T0. A hub that accepts the late result shows B (or `ok: false`) there, so the stale result is detected even though a same-answer read would leave the body unchanged.
- Step 5: N2 is below 4 times N1 for each source, and the sum of N2 over the five sources is below 1.5 times the sum of their N1 (a duplicate loop makes every source about 2 times N1, so the sum fails). No lower bound applies to N2. A source with 0 in all three windows fails here (no count is below 4 times 0), so every source, the conversation read included, must read while a page is connected. A failure prints the counts it judged.
- Step 6: the settle wait returns within its bound, and its count holds every call the held pass logs after the release (today its `worker-list` and `task-list` calls). 0 new log lines between that count and the count 1.5 s later, including no `inbox` call with the conversation `--limit` and no chiefUnread read.
- Step 7: the hub stays up; orca, plannotator and github show `ok: false` (each has an eligible read: the open gate and the MR URL); the client gets a push.
- Step 8: the wait rejects at its bound (about 400 ms, not at the 10 s default) with an error whose message names the counts it sampled, starting at the first one (`counts sampled: 1000`). A wait that returned a count, or looped past its bound, fails the step.

Baseline (validator): on the base, step 6 with the same order (the hold file removed 700 ms after the disconnect) and the fixed 500 ms wait started at the disconnect in place of the settle wait fails at the check after the 1.5 s wait: the fixed wait ends while the read is still held, and the held pass logs its second-stage calls after the count. The validator records the printed `Expected`/`Received` line.

Run evidence (validator, once, not part of the permanent suite): on a scratch clone (`git clone --shared` into the run folder's `scratch/`, never `hub/` of the worktree), `pause` in `hub/snapshot.ts` leaves the plannotator loop running when a marker that the scratch copy of the test sets just before the step 6 disconnect is present. The marker is absent at the pauses of steps 4 and 5, so only step 6 sees the leak. Expected: step 6 fails at the bounded settle wait, within its 10 s bound, and the failure prints the counts it sampled. The same clone with no marker passes. The validator removes the scratch folder after.

Repeat (validator): `bun test --rerun-each=5 test/hub-idle.test.ts -t ARK-T241` as the quick repeat, then the race proof of step 6: 20 separate `bun test test/hub-idle.test.ts -t ARK-T241` processes beside a loaded suite, each green.

## Screenshot checkpoints

none: process, call-log and event-stream assertions only
