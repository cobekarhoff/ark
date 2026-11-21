---
id: ARK-T753
title: ARK-T753 A full ark test strips base, head and census from the folder of a case that is gone and keeps its other files
level: integration
technique: state transition (full run with a case gone from the suite), equivalence classes (orphan case folder with extra files and a nested folder; extra files of a live case; folder with no base/head)
priority: high
risk: The folder of a case that is gone keeps a stale base/head/census, so merge-request evidence and the hub list a result for a case the run no longer has; or the merge deletes the whole folder with the worker's cause.md
status: active
changed_by: 2026-11-20-ARK-614-1
---

## Objective

Prove that a full `ark test` removes `base`, `head` and `census` from the folder of a case that no longer exists in the suite and keeps every other entry of that folder. Serves ARK-614 AC2 (orphan case folder). ARK-T263 owns AC2's quick-run clause.

Expected: When a full `ark test` publishes its evidence and a folder under `results/evidence` belongs to a case the run does not have, the system shall remove its `base`, `head` and `census` folders and keep its other files and folders.

## Preconditions

- The evidence fixture of `test/detached-runner.test.ts` (`evidenceFixture(false)`): one suite with one case, `DET-T1`.
- A full `ark test` of the run has finished with exit 0.
- Then, written by hand into `results/evidence/`:
  - an orphan case folder `DET-T9/` (no test carries `DET-T9`) with `base/result.json`, `head/result.json`, `head/command.log`, `census/result.json`, `cause.md` and `logs/repeat.md`;
  - `DET-T1/cause.md` beside the live case's results;
  - `AC3.md` and `AC8/notes.md`.

## Steps

1. Commit a change to the mirror so the suite runs again. Run a full `ark test <run>` and wait for exit 0.
2. List the tree of `results/evidence` with `treeOf`.

## Expected results

- After step 2, `DET-T9/` holds exactly `cause.md` and `logs/repeat.md`, with their content unchanged; it has no `base`, `head` or `census`.
- After step 2, `DET-T1/{base,head}` hold this run's results and `DET-T1/cause.md`, `AC3.md` and `AC8/notes.md` are unchanged.
- After step 1, nothing next to `results/evidence` starts with `evidence` other than `evidence` itself.
- At the base of this ticket the validator shows the test failing on `DET-T9/cause.md` missing after step 2.

## Screenshot checkpoints

none: the case compares files on disk; there is no screen.
