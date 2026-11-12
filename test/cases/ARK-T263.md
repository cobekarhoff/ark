---
id: ARK-T263
title: ARK-T263 A quick ark test leaves every evidence file of the last full run unchanged
level: integration
technique: state transition (full run, then quick run), before/after comparison of the evidence folder
priority: high
risk: A quick run deletes, appends to or overwrites the evidence of the last full run, so ark merge-request open finds no evidence or a "not run" result and the lead must run the full test again
status: active
changed_by: 2026-11-11-ARK-422-1
---

## Objective

Prove that `ark test --quick` leaves the case evidence of the last full `ark test` of the same run byte for byte as it was. Serves ARK-422 AC1.

Expected: When `ark test --quick` runs after a full `ark test`, the system shall leave every file under `results/evidence` unchanged.

## Preconditions

- A run with a workspace mirror and a suite whose test files carry test case IDs and write `command.log` and `result.json` evidence.
- A full `ark test` of the run has finished and written `results/evidence/<case id>/{base,head}/` (`result.json`, `command.log`).

## Steps

1. Run the full `ark test <run>` and wait for it.
2. Record the path, size and content hash of every file under `results/evidence`.
3. Change a test file in the run's workspace and commit it, so the quick run has a changed file to run.
4. Run `ark test <run> --quick` and wait for it.
5. Record the files under `results/evidence` again.

## Expected results

- The set of files, and the content of each, equal those of step 2. No file is removed, appended to or overwritten (the `command.log` has no second run in it; no `result.json` says `not run`).
- No staging folder is left next to `results/evidence`.

## Screenshot checkpoints

None. There is no screen to check.
