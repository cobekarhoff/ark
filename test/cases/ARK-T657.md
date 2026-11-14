---
id: ARK-T657
title: ARK-T657 ark companions sync sends a live companion one wake message for each new event of a trigger it subscribes to, none for older events on its first sync, none on a repeat sync, and resends an event whose send failed
level: integration
technique: state transition on the cursor (no cursor, first sync, new event, repeat sync, failed send, retry) and equivalence classes on trigger (run.merged, run.started, criteria.opened, escalation, ci.failed, an unsubscribed trigger, a run.closed that is not merged)
priority: high
risk: "a companion added to a mature project is woken for every old run on its first sync; one event wakes twice (every chief state repeats it); an event is lost because the cursor moved before the send succeeded, or a crash repeats it; a trigger the companion did not list wakes it; an aborted run counts as merged; an unreadable run crashes the sync and wakes nobody; a failing gh or glab is read as no failed CI and the failure is never sent"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove that for each new event of a subscribed trigger, `ark companions sync` sends that companion one wake message with the trigger and the run id, once for each event, using a cursor under `companions/<name>/`, and sends nothing for events that were there before the companion's first sync. Serves ARK-480/AC3.

## Preconditions

- A temp `ARK_HOME`, project `p`, the fake orca of ARK-T656 with live workers (it logs each `send` with `--to`, subject and body), and the test clock of `cli/clock.ts` for every event time and cursor time. No real clock is read.
- Two companions: `merger` with `on: [run.merged, escalation]`, and `starter` with `on: [run.started, criteria.opened, ci.failed]`. Both have a live worker.
- Run fixtures written with `writeRun`: `R1` already closed `merged`, started, with an evaluation that blocks (criteria gate opened), with an `escalation.requested`; `R2` an open run with an open MR; `R3` whose `events.ndjson` has a bad line (unreadable).
- A fake `gh` for the MR status of `R2`: all checks pass, settable to one failed check named `unit` or two failed checks, and settable to fail (exit 1).

## Steps

1. First sync, `ark companions sync --project p`. Read the call log and `companions/<name>/` for each companion.
2. Repeat the sync.
3. Append to `R2` a `run.closed` event with outcome `merged`, and to `R4` (new run) a `run.started`. Advance the test clock. Run the sync.
4. Append to `R2` an `escalation.requested` event. Run the sync. Repeat it.
5. Append a `run.closed` with outcome `aborted` to a run. Run the sync.
6. Set the fake `gh` to report the failed check `unit` on `R2`'s MR. Run the sync twice. Then add the failed check `lint` and run it again. Then set `gh` to fail and run it.
7. Make the fake `send` fail once while a new `run.merged` event is waiting. Run the sync, then run it again with `send` working.
8. Add a third companion `late` with `on: [run.merged]` after step 3 (a project with old merged runs) and run the sync.

## Expected results

- Step 1: the call log has no `send` for any companion although `R1` holds a merge, a start, a gate and an escalation; each `companions/<name>/` holds a cursor; the sync exits 0 and names `R3` as unreadable on a line, without stopping.
- Step 2: no `send`.
- Step 3: `merger` gets one `send` whose body names the trigger `run.merged` and run id `R2`; `starter` gets one `send` naming `run.started` and `R4`; `merger` is not sent `R4` and `starter` is not sent `R2`'s merge.
- Step 4: `merger` gets one `send` naming `escalation` and `R2`; the repeat sends nothing. `starter` is not woken by it.
- Step 5: no `send` (an aborted run is not `run.merged`).
- Step 6: `starter` gets one `send` naming `ci.failed`, the run id `R2` and the failed check `unit`; the second sync sends nothing; the new check `lint` sends one more; with `gh` failing, the sync exits 0, prints a line that says the CI of `R2` could not be read, sends nothing, and the failure of `unit` and `lint` is not sent again after `gh` works again.
- Step 7: the sync with the failing `send` reports the failure on a line, and the cursor does not pass the event; the next sync sends it once and then no more. [INFERENCE: at-least-once; a crash between the send and the cursor write may repeat an event, which the case does not assert.]
- Step 8: `late` gets no `send` (a first sync for this companion has no wake for older events although the other companions have cursors).
- Each cursor and each wake time in `companions/<name>/` comes from the test clock; `bun test test/wallclock.test.ts` exits 0.
- Which of `run.started` and `criteria.opened` wakes for a gate that opens at run start is fixed by the plan (evaluation.md names it open); the case asserts that one gate opening wakes `starter` once for `criteria.opened`, and a run start wakes it once for `run.started`, never two wakes for the same trigger of one event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
