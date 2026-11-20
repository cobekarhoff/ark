---
id: ARK-T731
title: ARK-T731 ark run start and ark evaluation record with blockers wake each live subscribed companion before they exit, with the sync wake's subject, body, wake.log line and cursor, and the next ark companions sync sends nothing for that event
level: integration
technique: state transition on the cursor (no cursor, cursor, command wake, catch-up sync) and equivalence classes on trigger (run.started, criteria.opened from an evaluation with blockers and from one without) and on subscription (listed, not listed)
priority: high
risk: "a companion learns of a start or of the criteria gate only at the next sync (9 to 172 min late); the command wakes with a message other than the sync wake (another subject or body); the command moves the cursor so far that an older unsent wake (an escalation) is lost; the command writes no wake.log line or no cursor, so the next sync sends the same event again; the command with a CI-subscribed companion empties cursor.ci and the next sync wakes every failed check again; a command run before the companion's first sync writes a cursor that makes the next sync wake every older event of every run; a companion that does not list the trigger is woken; an evaluation with no blockers wakes; the command starts, stops or releases a worker"
status: active
changed_by: 2026-11-20-ARK-521-1
---

## Objective

Prove that `ark run start` and `ark evaluation record` send the companion wake themselves, through the path sync uses, once for each event: the message is the one sync would send, `wake.log` and `cursor.json` are written, and a later `ark companions sync` and `ark chief state` send nothing for that event. Serves ARK-521/AC1, AC2 and AC3.

## Preconditions

- A temp `ARK_HOME`, project `p` with a repo, and the fake orca of ARK-T656 and ARK-T657 (`test/fake-companion-tools.ts`) with a Master Chief Run, a live worker for each companion, and a log of every call and every `send` (`--to`, subject, body). The test clock of `cli/clock.ts` gives every event time and cursor time.
- Companions: `starter` with `on: [run.started, criteria.opened, ci.failed]`, `merger` with `on: [run.merged, escalation]`, and `late` with `on: [run.started]` and no `cursor.json` yet (its first sync has not run). `starter` and `merger` each have a `cursor.json` from one earlier `ark companions sync`.
- A second project run: an older open run `R0` in `merge_requests_open` with an open MR and the fake `gh` reporting one failed check, so that a sync would wake `ci.failed` for it.
- The ticket and the run are made by the real commands (`ark run start`, `ark evaluation record`), not by `appendRaw`: this case drives the command boundary that ARK-T657 does not.

## Steps

1. Run `ark run start` for a new ticket `K1`. Read stdout, stderr, the call log, the `send` records, `companions/starter/wake.log` and `cursor.json` of each companion, and the `events.ndjson` of `K1`. Run `ark companions sync --project p` and read the same again. Run `ark chief state --project p` and read the `send` records again.
2. Run `ark evaluation record` for `K1` with a file that has two blockers. Read the same. Run `ark companions sync` and `ark chief state` again.
3. Start a new run `K2` with `ark run start`, then run `ark evaluation record` for `K2` with a file whose `blockers` list is empty. Read the same, then run `ark companions sync`.
4. Run `ark evaluation record` for `K1` again with blockers.
5. In a fresh state with a companion `both` (`on: [escalation, criteria.opened]`, live, with a cursor): append a raw `escalation.requested` event to `K1` with no sync after it, make the fake `send` fail once, then run `ark evaluation record` for `K1` with blockers. Run `ark companions sync` with `send` working.
6. In a fresh state where `starter` has a `worker.json` but no `cursor.json`, with an older merged run in the project, run `ark run start` for `K4`; read the files of `starter`, then run `ark companions sync`.

## Expected results

- Step 1: stdout is the run id and nothing else. The `send` records hold exactly one message for `K1`, to `starter`. `late` (no `cursor.json`) gets no `send` and no `cursor.json` is written for it; `merger` (does not list `run.started`) gets none. The message's subject is `Companion wake: run.started <run>` and its body is the literal wake text of the sync (the test pins the same literal that ARK-T657's sync assertions use, not a value computed by the code under test). `companions/starter/wake.log` has one new line and `cursor.json` is moved past the `run.started` event; `merger`'s cursor moved past it as well (an event with no wake). The call log holds no `worker-start`, `worker-stop`, or CI read for `R0`. `cursor.ci` of `starter` is unchanged (not emptied). The `run.started` line in `events.ndjson` is in place. After the sync and after `chief state`: no new `send` for `K1`, no second `wake.log` line.
- Step 2: `starter` gets exactly one `send` with the subject `Companion wake: criteria.opened <run>`, once; `merger` gets none; `wake.log` and the cursor moved as in step 1; stdout is the one `recorded evaluation: ...` line as it is with no companion; stderr is empty. The later sync and chief state send nothing for the event.
- Step 3: no `send` for the evaluation with no blockers; the cursor of `starter` moved past the `evaluation.recorded` event (a step with no wake); the later sync sends nothing for it.
- Step 4: a second `send` of `criteria.opened` (the same as sync does for a second evaluation with blockers), once.
- Step 5: the failed `send` leaves the older escalation unsent: the command prints one not-sent line naming the older trigger `escalation` (the line text is owned by ARK-T732), and the cursor of `both` does not pass the escalation. The next sync sends the escalation and then the `criteria.opened` wake, in event order, each once; no event is lost.
- Step 6: no `send` and no `cursor.json` written for `starter` by the command (the first-sync rule: with no cursor, a command wake starts at the present and sends nothing). The next sync, which is the first for `starter`, also sends nothing for the older merged run and writes the cursor. The older runs of other companions are not woken.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
