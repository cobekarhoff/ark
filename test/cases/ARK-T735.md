---
id: ARK-T735
title: ARK-T735 When the fake orca fails run-list, inbox, or worker-list or task-list of one open run, the orca pass returns no value, the source reads not ok, and the snapshot keeps the last agents and waits of every run; when only Master Chief's worker-list fails, the pass stays ok and loses only the run lead it alone listed
level: integration
technique: equivalence classes (no failure, failing run-list, failing inbox, failing worker-list of one of three runs, failing task-list of one run, failing worker-list of Master Chief) and state transition (ok, failed, ok again with changed data)
priority: medium
risk: >-
  a change to the orca pass (yields between runs, bounded spawns, a worker) turns a failure of one call into a partial value: the run whose call failed vanishes from the agents, or its good neighbours show a half-read list, or the pass publishes an empty list of waits, so the page shows no one waiting when Orca could not answer; or a failure leaves the slot not ok forever after the call works again; or a failure of Master Chief's worker-list, which today only hides a run lead that nothing else lists, fails the whole pass, or leaves the run lead of a run in the agents from a stale read
status: active
changed_by: 2026-11-20-ARK-613-1
---

## Objective

Prove the failure rules of the orca pass hold under the fix of ARK-606 (AC1: "the pass still returns the same snapshot"). Expected: When `run-list`, `inbox`, or `worker-list` or `task-list` of one open run, fails, the system shall return no value for the pass (the source reads not ok, the page keeps the last answer and its age, never an empty list of waits); when only Master Chief's `worker-list` fails, the system shall keep the pass ok and show no run lead for a run that only Master Chief's list names; and when the call works again the next pass shall read ok with the new data.

What the code does (hub/sources.ts `readOrca`): its comment says a failed `worker-list` or `task-list` "drops that run", but the code sets `failed` and returns `null` for the whole pass (`return failed ? null : { agents, waits }`), and `read()` of hub/snapshot.ts then sets `ok` false and keeps the slot's last value. This case pins the code: the whole pass fails, no run is dropped alone. `run-list`, `terminal list` and the `inbox --limit 200` call of `readOrca` also return `null`. Master Chief's `worker-list` is the exception: the code records an empty list for the project (`chiefWorkers.set(project, list.ok ? list.value : [])`) and the pass goes on. If the implementer or reviewer wants the comment's rule or another rule for Master Chief's call, that is a change of contract the human decides, not a fix inside ARK-606.

Question 1: the null-on-failure rule of the pass, the page keeping its last answer, and the one call that does not fail the pass. Question 2: a yield or a bounded spawn pool that returns the runs it finished (a partial `OrcaValue`), a worker that posts nothing back and leaves `ok` true with stale data, or a pool that moves Master Chief's `worker-list` and changes what its failure does. Question 3: no test fails these calls of `readOrca` alone: the shared fake of `test/hub-fixtures.ts` has no switch that fails one of `worker-list`, `task-list` or `run-list`; its `orca.mode` fails every orca call (`down`) or every command after two answers (`twice`), and ARK-T662 (test/hub.test.ts, `orcaMode: "down"`) uses it from the start with no earlier good answer, so no case covers "keeps the last answer". Its `orca.inboxfails` switch (used by ARK-T319) exempts the `--limit 200` call of `readOrca` (`*" --limit 200 "*) ;;`) and fails only the conversation read (`--limit 10000`), so ARK-T319 owns that read and not this one; ARK-T256 owns the queue failure; and ARK-T734 only proves the large green pass. Question 4: no hook; the test starts the real hub.

## Waiting rule (test/wallclock.test.ts, ARK-T126)

No `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)`. A wait is a poll of `GET /api/health` that ends when the `orca` `ended_at` advances (the requests are the wait). The validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- The `stage()` of `test/hub-stall-support.ts` with its fake `orca` opt-in files from ARK-T734 (`orca.workers`, `orca.workers.<orca run id>`, `orca.tasks`), plus one more opt-in file read only by this test: `orca.fail`, holding lines `<verb> <orca run id>` (`worker-list`, `task-list`) or `run-list` or `inbox`; the fake exits 1 for a call that matches a line (`inbox` matches every `inbox` call without `--terminal`, so the `--limit 200` call of `readOrca`). The shared fake of `test/hub-fixtures.ts` is not edited; the other callers of this `stage()` are ARK-T699, ARK-T700, ARK-T701, ARK-T702, ARK-T703 and ARK-T751. The first five see the same answers as now because they write none of these files. ARK-T751 writes `orca.tasks` and `orca.tasks.pending`, and ARK-T735 writes `orca.tasks` but not `orca.tasks.pending`, so the two never read each other's answers (each has its own temp state folder).
- One more opt-in file, read only by step 9: `orca.null`, holding lines `<verb> <orca run id>`; the fake answers `{"result":null}` (exit 0, no rows) for a call that matches a line.
- Three open runs in `building`, each with its Orca run (objective `Ark run <run>`), and Master Chief's Orca run (`Master Chief: p tickets`, its terminal connected). The runs 1 and 3 have a connected run lead terminal. The run 2 has a run lead terminal that `orca.terminals` does not list as connected, and Master Chief's run lists that lead as a live worker (`orca.workers.<chief orca run id>`, its `terminal` the lead's handle, a `projection` with liveness), so the agents of run 2 hold a run lead with presence `running`, from Master Chief's `worker-list` alone.
- Each open run has its own `orca.workers.<orca run id>` with two workers, each with a `taskId`; `orca.tasks` holds the task of each worker with a distinct title in the form `stepTask` reads (hub/sources.ts), `<step id> (<role>, <repo>)`, for example `s1 (implementer, .)` and `s2 (validator, .)`, because the agent title comes from `task-list` and a worker row has no title; the step id and the role of the agent come from that title. One unread `question` in `orca.inbox` for run 2 gives its wait.
- `ARK_HUB_INTERVAL_MS=2000`, a held `/events` stream, a test timeout of 60 s.

## Steps

1. Start the hub, hold `/events`. Poll health until the `orca` `ended_at` has advanced twice. Read `/api/snapshot` and keep each run's agents and waits and `sources.orca` as `good`. Assert run 2 holds a run lead with presence `running`.
2. Write `orca.fail` with `worker-list <orca run id of run 2>`. Poll until the `orca` `ended_at` advanced twice. Read `/api/snapshot`.
3. Replace `orca.fail` with `task-list <orca run id of run 2>`; poll twice; read the snapshot.
4. Replace `orca.fail` with `run-list`; poll twice; read the snapshot.
5. Replace `orca.fail` with `inbox`; poll twice; read the snapshot.
6. Replace `orca.fail` with `worker-list <chief orca run id>`; poll twice; read the snapshot.
7. Remove `orca.fail` and change the title of one worker's task of run 3 in `orca.tasks` by adding a note after the step id and keeping the form (`s2-1 (validator, .)` becomes `s2-1 retry (validator, .)`, so the step and the role stay). Poll twice; read the snapshot.
8. Stop the hub with SIGTERM and await its exit.
9. Write 150 more open runs (each with an Orca run, a run lead, one worker), list `worker-list <orca run id>` of every one of them in `orca.null`, and start a second hub with `/events` held. The fake answers those reads with `{"result":null}`, so `orcaPages` throws inside the worker of hub/orca-worker.ts. Poll until the `orca` `ended_at` has advanced twice. Read `/api/snapshot`, then stop the hub with SIGTERM and await its exit.

## Expected results

- Steps 2 to 5: `sources.orca.ok` is false, and the agents and waits of all three runs equal `good` (the page keeps the last answer; run 2 is not dropped, runs 1 and 3 are not partial, the waits list of run 2 still holds its question and is not emptied). The health route still shows an `orca` pass with a duration and an end time (a failed pass is a pass).
- Step 6: `sources.orca.ok` is true. The agents of run 2 hold no run lead (nothing else lists it); the agents of runs 1 and 3 and every other agent of run 2 equal `good`; the waits equal `good`.
- Step 7: `sources.orca.ok` is true again, the run lead of run 2 is back with presence `running`, and the changed task title shows in the agent of its worker in run 3, with its step and role as before, and in no other agent.
- Red on unfixed code: none; the case passes at base and guards the fix. The deletions that must turn it red: returning the runs that finished when one call failed (steps 2 and 3); setting the waits of a failed pass to an empty list (steps 2 to 5); failing the pass when only Master Chief's `worker-list` fails, or keeping the run lead of run 2 from a stale answer (step 6); leaving `ok` false after the call recovers (step 7).
- Step 9: a throw inside the orca worker turns into a null pass (the catch of hub/orca-worker.ts posts `null`; the `onerror` and `close` handlers of `inOrcaWorker` reject for a worker that dies), so `sources.orca.ok` is false, the `orca` `ended_at` still advances and the hub keeps serving the health polls and the snapshot. Removing the catch of hub/orca-worker.ts together with the `onerror` and `close` handlers of `inOrcaWorker` turns it red: the pass never answers, `ended_at` never advances and the test times out (checked in a scratch clone of head: ARK-T735 failed at its 60 s timeout; the other steps do not throw in the worker).

## Screenshot checkpoints

none: HTTP JSON fields only.
