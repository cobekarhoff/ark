---
id: ARK-T657
title: ARK-T657 ark companions sync sends a live companion one wake message for each new event of a trigger it subscribes to, none for older events on its first sync, none on a repeat sync, and resends an event whose send failed
level: integration
technique: state transition on the cursor (no cursor, first sync, new event, repeat sync, failed send, retry) and equivalence classes on trigger (run.merged, run.started, criteria.opened from an evaluation with blockers and from one without, escalation, ci.failed, an unsubscribed trigger, a run.closed that is not merged)
priority: high
risk: "a companion added to a mature project is woken for every old run on its first sync; one event wakes twice (every chief state repeats it); an event is lost because the cursor moved before the send succeeded, or a crash repeats it; a trigger the companion did not list wakes it; an aborted run counts as merged; an unreadable run crashes the sync and wakes nobody; a failing gh is read as no failed CI and the failure is never sent; a run that starts with criteria_gate true wakes criteria.opened as well as run.started"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove that for each new event of a subscribed trigger, `ark companions sync` sends that companion one wake message with the trigger and the run id, once for each event, using a cursor under `companions/<name>/`, and sends nothing for events that were there before the companion's first sync. Serves ARK-480/AC3.

Trigger rules (plan decision): `run.merged` is a `run.closed` event with outcome `merged`; `run.started` is the `run.started` event and wakes `run.started` subscribers only; `criteria.opened` is the `evaluation.recorded` event with at least one blocker, which opens the criteria gate (phase `awaiting_criteria`), and wakes `criteria.opened` subscribers only; `escalation` is `escalation.requested`; `ci.failed` is a failed check on the MR of a run in phase `merge_requests_open`. CI is read only for runs in `merge_requests_open`.

## Preconditions

- A temp `ARK_HOME`, project `p`, the fake orca of ARK-T656 with live workers (it logs each `send` with `--to`, subject and body), and the test clock of `cli/clock.ts` for every event time and cursor time. No real clock is read.
- Two companions: `merger` with `on: [run.merged, escalation]`, and `starter` with `on: [run.started, criteria.opened, ci.failed]`. Both have a live worker.
- Run fixtures written with `writeRun`: `R1` closed `merged`, started with `criteria_gate: true`, with an `evaluation.recorded` that has a blocker, and with an `escalation.requested`; `R2` an open run in `merge_requests_open` with an open MR; `R5` an open run with no MR (phase `building`); `R3` whose `events.ndjson` has a bad line (unreadable).
- A fake `gh` for the MR status of `R2`: all checks pass, settable to one failed check named `unit` or two failed checks, and settable to fail (exit 1). `glab` is not faked: the GitLab host path goes through the same `mergeRequestStatus` function, whose failure is proved by this case through `gh`; no second case.

## Steps

1. First sync, `ark companions sync --project p`. Read the call log and `companions/<name>/` for each companion.
2. Repeat the sync.
3. Append to `R5` a `run.closed` event with outcome `merged`, and write `R4` (new run, only `run.started` with `criteria_gate: true`, no evaluation yet). Advance the test clock. Run the sync.
4. Append to `R4` an `evaluation.recorded` event with a blocker. Run the sync. Repeat it. Then write a new run `R6` (`run.started`, `criteria_gate: true`) with an `evaluation.recorded` that has no blockers (empty `blockers` list), and run the sync.
5. Append to `R2` an `escalation.requested` event. Run the sync. Repeat it.
6. Append a `run.closed` with outcome `aborted` to `R6`. Run the sync.
7. Set the fake `gh` to report the failed check `unit` on `R2`'s MR. Run the sync twice. Then add the failed check `lint` and run it again. Then set `gh` to fail and run it. Then set `gh` to pass and run it.
8. Make the fake `send` fail once while a new `run.merged` event (a third run `R7` closed `merged`) is waiting. Run the sync, then run it again with `send` working.
9. Add a third companion `late` with `on: [run.merged]` after step 3 (a project with old merged runs) and run the sync.

## Expected results

- Step 1: the call log has no `send` for any companion although `R1` holds a merge, a start, a gate and an escalation; each `companions/<name>/` holds a cursor; the sync exits 0 and names `R3` as unreadable on a line, without stopping.
- Step 2: no `send`.
- Step 3: `merger` gets one `send` whose body names the trigger `run.merged` and run id `R5`; `starter` gets one `send` naming `run.started` and `R4`, and no `send` names `criteria.opened` (a start with `criteria_gate: true` is not a gate opening); `merger` is not sent `R4` and `starter` is not sent `R5`'s merge. No `send` names `ci.failed`: `R5` has no open MR and the fake `gh` log has no call for `R5`.
- Step 4: `starter` gets one `send` naming `criteria.opened` and `R4`; the repeat sends nothing. The `evaluation.recorded` with no blockers of `R6` sends no `criteria.opened` (its `run.started` sends one `run.started` to `starter`, once). `merger` is sent nothing.
- Step 5: `merger` gets one `send` naming `escalation` and `R2`; the repeat sends nothing. `starter` is not woken by it.
- Step 6: no `send` (an aborted run is not `run.merged`).
- Step 7: `starter` gets one `send` naming `ci.failed`, the run id `R2` and the failed check `unit`; the second sync sends nothing; the new check `lint` sends one more; with `gh` failing, the sync exits 0, prints a line that says the CI of `R2` could not be read, and sends nothing; after `gh` works again, the failures of `unit` and `lint` are not sent again.
- Step 8: the sync with the failing `send` reports the failure on a line, and the cursor does not pass the event; the next sync sends it once and then no more. [INFERENCE: at-least-once; a crash between the send and the cursor write may repeat an event, which the case does not assert.]
- Step 9: `late` gets no `send` (a first sync for this companion has no wake for older events although the other companions have cursors).
- Each cursor and each wake time in `companions/<name>/` comes from the test clock.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
