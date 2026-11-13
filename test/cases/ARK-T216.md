---
id: ARK-T216
title: ARK-T216 A restored step and a fresh restart keep each session file with one owner window in retro usage
level: integration
technique: equivalence classes (one file over two windows, two files one per window)
priority: medium
risk: after an interrupt the second window of the step loses its session file in the ARK-348 owner rule, so its tokens are lost or counted twice; the recorded `session` path does not match the file on disk
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that the retro usage attribution gives each omp session file to exactly one owner after a restart, for a restore (one file over two windows) and for a fresh worker (two files).

## Preconditions

- A fake `orca` executable on `PATH` (a script over `$FAKE_ORCA_DIR/state.json` that logs every call to `calls.log`), as `test/run.test.ts` does. No real Orca, no real `ark test`, no `omp`, no test-runner. A `worker-start` call from the fake creates a terminal record and writes nothing else.
- A fake session folder in `ARK_OMP_SESSIONS` (a scratch folder under the host temp folder) that the fake Orca fills on demand with one session file for the worktree cwd.
- A scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree. Every child process the case starts is killed in teardown, and the scratch folders are removed.
- A fake session folder in `ARK_OMP_SESSIONS` with session files built by the test: restore case, one file with turns in both windows; fresh case, two files, one per window.
- The run events from the start commands of cases 210 and 212 (the fake Orca), with each worker event's `session` path.
- ARK-425: each `worker.started` records its `session`. Restore: both windows' events name the same file. Fresh: the second window's event names the second file; the first file starts before its `step.started`.

## Steps

1. Build the restore run: start, interrupt, restore start. Put one session file with turns in both windows.
2. Run the retro usage read and list each file with its owner.
3. Build the fresh run: start, interrupt, fresh start with a second session file. Run the read again.

## Expected results

- Restore: the usage shall list the file once, with one owner, and its tokens shall be counted once.
- Fresh: the usage shall list two files, each with one owner, and no token shall be counted twice or dropped.
- Restore with the session recorded in both windows: the file is listed once under the step, not doubled and not moved to Unassigned. Fresh: the later round's file maps to the step and the earlier round's file stays with its own round. This case owns restore and fresh attribution after ARK-425.
- The `session` path of each worker event shall match a file in the fake session folder.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
