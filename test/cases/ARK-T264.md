---
id: ARK-T264
title: ARK-T264 A stopped full ark test leaves the evidence of the previous full run in place
level: integration
technique: state transition (full run in flight, stop before evidence is complete)
priority: high
risk: A full run that is stopped deletes the previous evidence at its start, or mixes the partial files of finished suites into it, so the lead loses proof it already had
status: active
changed_by: 2026-11-11-ARK-422-1
---

## Objective

Prove that `ark test --stop` of a running full test leaves the evidence of the previous full run unchanged, with no partial files of the stopped run in it. Serves ARK-422 AC2.

Expected: When `ark test --stop` ends a running full test before it writes evidence, the system shall leave every file under `results/evidence` as the previous full run wrote it.

## Preconditions

- A run with a workspace mirror and two suites: one finishes at once and writes evidence for its cases; one blocks until it is killed.
- A full `ark test` has finished earlier and written `results/evidence`.

## Steps

1. Record the path, size and content hash of every file under `results/evidence`.
2. Start a full `ark test <run>` with the blocking suite held (the detached runner pattern of the existing tests).
3. Wait until the quick suite has finished, so that its evidence was written during the run.
4. Run `ark test <run> --stop` and wait until the runner is gone.
5. Record the files under `results/evidence` again.

## Expected results

- The set of files, and the content of each, equal those of step 1. Nothing of the stopped run is in the folder.
- A later full `ark test` of the run starts normally and is not blocked by a staging folder the stopped run left.

## Screenshot checkpoints

None. There is no screen to check.
