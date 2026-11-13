---
id: ARK-T308
title: ARK-T308 two steps started through the current start path each open their worker's session transcript, and no step session is unassigned
level: integration
technique: state transition (start path event order), equivalence classes on file owner (step one, step two, run lead), boundary value (session file first timestamp before step.started)
priority: high
risk: the hub maps a session file by the window opened by step.started, but the start path records step.started after the worker launched, so every step worker's file starts before its window and lands under Unassigned session files; a fixture that writes events in the old order passes for the wrong reason
status: active
changed_by: 2026-11-12-ARK-425-1
---

## Objective

Prove that for a run whose steps start through `ark run step <run> <step> start` as on main today, the hub maps each step's worker session file to its step. Serves ARK-425/AC1.

Expected: When a step is started through the current start path, the system shall show that step's worker session file on the step transcript page, and shall list no step worker's session under Unassigned session files.

## Preconditions

- A temporary `ARK_HOME` and a fixture project with an approved plan of two steps, `build` and `check`.
- The fake `orca` of `test/fake-orca.ts`, so `startWorker`, `createTerminal`, `bindTerminal` and `watchSession` run for real against it.
- Two session files in the isolated sessions folder, both with the run's worktree as `cwd`. File B starts before `build` is recorded as started; file C starts before `check` is recorded as started. The fake `watchSession` hands each to its launch, so the `worker.started` event carries it in `session`.
- A third file L, the run lead, starts before the first step.

## Steps

1. Run `ark run step <run> build start` through the CLI; read `events.ndjson`.
2. Run `ark run step <run> check start` after finishing `build`.
3. Check the first timestamp of file B is earlier than the `step.started` time of `build`, and the same for C and `check` (the case is vacuous otherwise).
4. Open the hub step transcript page of `build`, then of `check`.
5. Open the run page and read the Unassigned session files list.

## Expected results

- Each `worker.started` event holds the path of its own file in `session`, and `step.started` precedes `worker.started` for both steps.
- The `build` transcript page shows the entries of file B and not the text "No session file maps here"; the `check` page shows those of file C.
- The run page lists the run lead file L under the run lead and nothing under Unassigned session files; B and C are not listed there.
- A usage or retro cost placement computed from the same events (`ark retro`, hub run usage) puts the cost of B on `build` and of C on `check`.

## Screenshot checkpoints

none: the case reads transcript entries and list contents, which the assertions check as text.
