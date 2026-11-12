---
id: ARK-T269
title: ARK-T269 After a stopped full ark test the next full run removes the evidence folders of renamed cases and writes the new ones
level: integration
technique: state transition (completed full run, stopped full run, completed full run) with an id rename
priority: high
risk: A stopped full run removes or alters evidence folders of the last completed full run, or the next full run keeps the folder of a case id that no longer exists, so merge-request evidence lists a case that is gone or lacks the renamed one
status: active
changed_by: 2026-11-11-ARK-422-1
---

## Objective

Prove the evidence folder of a run across a stopped and a following full run: the stop leaves every evidence folder of the last completed full run in place, and the next full run holds exactly the folders of the cases it has, so a renamed case shows under its new id only. Serves ARK-422 AC3.

Expected: When a full `ark test` follows a stopped full run, the system shall keep a folder under `results/evidence` for each case id of the new run and no folder for a case id the new run does not have.

## Preconditions

- A run with a workspace mirror and two suites: a quick suite that finishes at once and runs a case with id A, and a suite that blocks until it is released or killed.
- A full `ark test` has finished and written `results/evidence` with a folder for case A.

## Steps

1. Record the folders under `results/evidence`, and the path and content of every file in them.
2. Commit a change to the mirror so the next run does not reuse the earlier result. Start a full `ark test <run>` with the blocking suite held.
3. Wait until the quick suite has finished and the blocking suite is running.
4. Run `ark test <run> --stop` and wait until the runner is gone.
5. Record the folders and files under `results/evidence` again and compare them with step 1.
6. Rename case A to case B in the test file of the quick suite and commit it to the mirror. Release the blocking suite.
7. Run a full `ark test <run>` and wait for it to finish with exit 0.
8. List the folders under `results/evidence`.

## Expected results

- After step 5 the folders, files and file contents equal those of step 1. The folder of case A is present; no folder of case B exists.
- After step 8 the folder of case B is present with its evidence files, and the folder of case A is gone.
- The next full run exits 0 and lists no folder for an id its suites do not run.

## Screenshot checkpoints

None. There is no screen to check.
