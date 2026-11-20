---
id: ARK-T735
title: ARK-T735 When the fake orca fails run-list, worker-list or task-list of one open run, the orca pass returns no value, the source reads not ok, and the snapshot keeps the last agents and waits of every run until the failure clears
level: integration
technique: equivalence classes (no failure, failing run-list, failing worker-list of one of three runs, failing task-list of one run) and state transition (ok, failed, ok again with changed data)
priority: medium
risk: a change to the orca pass (yields between runs, bounded spawns, a worker) turns a failure of one call into a partial value: the run whose call failed vanishes from the agents, or its good neighbours show a half-read list, or the pass publishes an empty list of waits, so the page shows no one waiting when Orca could not answer; or a failure leaves the slot not ok forever after the call works again
status: active
changed_by: 2026-11-20-ARK-606-1
---

## Objective

Prove the failure rule of the orca pass holds under the fix of ARK-606 (AC1: "the pass still returns the same snapshot"). Expected: When `run-list`, or `worker-list` or `task-list` of one open run, fails, the system shall return no value for the pass (the source reads not ok, the page keeps the last answer and its age, never an empty list of waits), and when the call works again the next pass shall read ok with the new data.

What the code does (hub/sources.ts `readOrca`): its comment says a failed `worker-list` or `task-list` "drops that run", but the code sets `failed` and returns `null` for the whole pass (`return failed ? null : { agents, waits }`), and `read()` of hub/snapshot.ts then sets `ok` false and keeps the slot's last value. This case pins the code: the whole pass fails, no run is dropped alone. If the implementer or reviewer wants the comment's rule instead, that is a change of contract the human decides, not a fix inside ARK-606.

Question 1: the null-on-failure rule of the pass and the page keeping its last answer. Question 2: a yield or a bounded spawn pool that returns the runs it finished (a partial `OrcaValue`), or a worker that posts nothing back and leaves `ok` true with stale data. Question 3: no test fails `worker-list` or `task-list` of one run: the shared fake of `test/hub-fixtures.ts` has no switch for them (its switches are `orca.inboxfails`, `orca.psfails`, `orca.switchfails` and the unread-message `.fails` files), ARK-T319 owns the inbox failure, ARK-T256 owns the queue failure, and ARK-T734 only proves the large green pass. Question 4: no hook; the test starts the real hub.

## Waiting rule (test/wallclock.test.ts, ARK-T126)

No `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)`. A wait is a poll of `GET /api/health` that ends when the `orca` `ended_at` advances (the requests are the wait). The validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- The `stage()` of `test/hub-stall.test.ts` with its fake `orca` opt-in files from ARK-T734 (`orca.workers`, `orca.tasks`), plus one more opt-in file read only by this test: `orca.fail`, holding lines `<verb> <orca run id>` (`worker-list`, `task-list`) or `run-list`; the fake exits 1 for a call that matches a line. The shared fake of `test/hub-fixtures.ts` is not edited.
- Three open runs in `building`, each with its Orca run and a connected run lead terminal, two workers each in `orca.workers` with distinct titles, one unread `question` in `orca.inbox` for the second run.
- `ARK_HUB_INTERVAL_MS=2000`, a held `/events` stream, a test timeout of 60 s.

## Steps

1. Start the hub, hold `/events`. Poll health until the `orca` `ended_at` has advanced twice. Read `/api/snapshot` and keep each run's agents and waits and `sources.orca` as `good`.
2. Write `orca.fail` with `worker-list <orca run id of run 2>`. Poll until the `orca` `ended_at` advanced twice. Read `/api/snapshot`.
3. Replace `orca.fail` with `task-list <orca run id of run 2>`; poll twice; read the snapshot.
4. Replace `orca.fail` with `run-list`; poll twice; read the snapshot.
5. Remove `orca.fail` and change one worker's title in `orca.workers`. Poll twice; read the snapshot.
6. Stop the hub with SIGTERM and await its exit.

## Expected results

- Steps 2 to 4: `sources.orca.ok` is false, and the agents and waits of all three runs equal `good` (the page keeps the last answer; run 2 is not dropped, runs 1 and 3 are not partial, the waits list of run 2 still holds its question). The health route still shows an `orca` pass with a duration and an end time (a failed pass is a pass).
- Step 5: `sources.orca.ok` is true again and the changed worker title shows in the agents of its run.
- Red on unfixed code: none; the case passes at base and guards the fix. The deletions that must turn it red: returning the runs that finished when one call failed (steps 2 and 3); setting the waits of a failed pass to an empty list (steps 2 to 4); leaving `ok` false after the call recovers (step 5).

## Screenshot checkpoints

none: HTTP JSON fields only.
