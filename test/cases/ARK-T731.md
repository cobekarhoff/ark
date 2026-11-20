---
id: ARK-T731
title: ARK-T731 ark run start and ark evaluation record with blockers wake each live subscribed companion before they exit, with the sync wake's subject, body, wake.log line and cursor, and no wake goes out twice when a sync runs before, after or beside the command
level: integration
technique: state transition on the cursor (no cursor, cursor, command wake, catch-up sync) and equivalence classes on trigger (run.started, criteria.opened from an evaluation with blockers and from one without) and on subscription (listed, not listed); a race of two real processes (sync and run start) with a named repeat
priority: high
risk: "a companion learns of a start or of the criteria gate only at the next sync (9 to 172 min late); the command wakes with a message other than the sync wake (another subject or body); the command writes no wake.log line or no cursor, so the next sync sends the same event again; a sync that runs between the command's event and its wake makes both send the event (the command reads the cursor or builds its steps before it takes the lock); the command with a CI-subscribed companion empties cursor.ci and the next sync wakes every failed check again; a command run before the companion's first sync writes a cursor that makes the next sync wake every older event of every run; a companion that does not list the trigger is woken; an evaluation with no blockers wakes; the command starts, stops or releases a worker"
status: active
changed_by: 2026-11-20-ARK-521-1
---

## Objective

Prove that `ark run start` and `ark evaluation record` send the companion wake themselves, through the path sync uses, once for each event: the message is the one sync would send, `wake.log` and `cursor.json` are written, and no `ark companions sync` sends the event a second time, also one that runs beside the command. Serves ARK-521/AC1, AC2 and AC3. The failure path of the command is owned by ARK-T732.

## Preconditions

- A temp `ARK_HOME`, project `p` with a repo, and the fake orca of ARK-T656 and ARK-T657 (`test/fake-companion-tools.ts`) with a Master Chief Run, a live worker for each companion, and a log of every call and every `send` (`--to`, subject, body). The test clock of `cli/clock.ts` gives every event time and cursor time.
- Companions: `starter` with `on: [run.started, criteria.opened, ci.failed]`, `merger` with `on: [run.merged, escalation]`, and `late` with `on: [run.started]` and no `cursor.json` yet (its first sync has not run). `starter` and `merger` each have a `cursor.json` from one earlier `ark companions sync`.
- A second project run: an older open run `R0` in `merge_requests_open` with an open MR and the fake `gh` reporting one failed check, so that a sync would wake `ci.failed` for it.
- The ticket and the run are made by the real commands (`ark run start`, `ark evaluation record`), not by `appendRaw`: this case drives the command boundary that ARK-T657 does not.

## Steps

1. Run `ark run start` for a new ticket `K1`. Read stdout, stderr, the call log, the `send` records, `companions/starter/wake.log` and `cursor.json` of `starter`, and the `events.ndjson` of `K1`. Run `ark companions sync --project p` and read the `send` records and `wake.log` again.
2. Run `ark evaluation record` for `K1` with a file that has two blockers. Read the same. Run `ark companions sync` again.
3. Start a new run `K2` with `ark run start`, then run `ark evaluation record` for `K2` with a file whose `blockers` list is empty. Read the `send` records.
4. Run `ark evaluation record` for `K1` again with blockers.
5. Race, with two real processes and no fake delay: start `ark companions sync --project p` in a loop in one process and, at the same time, run `ark run start` for five new tickets one after the other in another. When both loops have ended, run one more sync and read the `send` records and `starter`'s `wake.log`. The repeat is named: `bun test --rerun-each=20` on the one file that holds the case is the quick repeat; the proof of the race is 20 separate `bun test` processes of that file beside the loaded suite (one process keeps module state and process timing between repeats).

## Expected results

- Step 1: stdout is the run id and nothing else; stderr is empty. The `send` records hold exactly one message for `K1`, to `starter`. `late` (no `cursor.json`) gets no `send` and no `cursor.json` is written for it; `merger` (does not list `run.started`) gets none. The subject is `Companion wake: run.started <run>`. The body is pinned in full from the test's own inputs, not from a value the code under test made: `trigger: run.started`, `run: <the run id printed on stdout>` and `ticket: <id> <title>` of the ticket the test wrote, joined by newlines. `companions/starter/wake.log` has one new line for `run.started` and `cursor.json` of `starter` is moved past the `run.started` event. The call log holds no `worker-start`, `worker-stop`, `worker-release` or CI read for `R0`. `cursor.ci` of `starter` is unchanged (not emptied). The sync that follows sends nothing new and adds no `wake.log` line: one message for `K1` in all.
- Step 2: `starter` gets exactly one more `send` with the subject `Companion wake: criteria.opened <run>`; `merger` gets none; `wake.log` and the cursor moved as in step 1; stdout is the one `recorded evaluation: ...` line, as with no companion; stderr is empty. The sync that follows sends nothing for the event.
- Step 3: the `send` records hold no message for the evaluation with no blockers.
- Step 4: a second `criteria.opened` message for `K1` (the same as sync sends for a second evaluation with blockers), once.
- Step 5: every one of the five runs has exactly one `run.started` message to `starter` and one `wake.log` line in all, whatever the interleaving. A command that prints a `not sent ... another sync is running` line (the sync held the lock) is allowed; the final sync then sent that wake, once. No run has two messages. Every command exited 0 with the run id alone on stdout.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
