---
id: ARK-T754
title: ARK-T754 A full ark test whose evidence publish fails leaves the old evidence whole and no staging or aside folder, and the next full run publishes
level: integration
technique: error guessing (fault injected through a real file system permission on a kept entry), state transition (full run, failed full run, full run after the fault is cleared)
priority: high
risk: The publish deletes or moves the old base/head, or kept entries, before the step that fails, so a failed swap loses the evidence the lead already had (the bug of today's rmSync then renameSync); or it reports success while nothing was published; or it leaves evidence.next or an aside folder that a later reader or the next run trips on
status: active
changed_by: 2026-11-20-ARK-614-1
---

## Objective

Prove that when the publish of a full `ark test` fails halfway, `results/evidence` stays exactly as it was, no `evidence*` folder is left beside it, and the next full run publishes normally once the fault is gone. Serves ARK-614 AC2 (failed swap).

Expected: If the publish of a full `ark test` fails, then the system shall leave every file under `results/evidence` as it was before the run, leave no other entry whose name starts with `evidence` in `results/`, and not exit 0.

## Preconditions

- The evidence fixture of `test/detached-runner.test.ts` (`evidenceFixture(false)`), with a finished full `ark test` (exit 0).
- Written by hand into `results/evidence/`: `AC3.md`, `AC8/notes.md` and `DET-T1/cause.md`.
- The test process does not run as root (`process.getuid() !== 0`): root ignores the permission the fault uses. Under root the test is skipped with that reason. CI (`ubuntu-latest`, user `runner`) and the host are not root.

## Steps

1. Record the tree of `results/evidence` with `treeOf`.
2. Set the mode of the folder `results/evidence/AC8` to `000`. The publish must carry this kept folder into the new evidence, and a copy or a move of it out of `results/evidence` then fails with `EACCES` (checked on macOS for both `cpSync` and `renameSync` to another parent; Linux refuses a rename of a directory to another parent without write permission on it).
3. Commit a change to the mirror so the suite runs again. Run a full `ark test <run>` and wait for it to end.
4. Set the mode of `AC8` back to `755`. Record the tree and list `results/`.
5. Run a full `ark test <run>` and wait for exit 0. Record the tree.

## Expected results

- Step 3 does not exit 0.
- After step 4 the tree equals that of step 1: `DET-T1/{base,head}` hold the results of the earlier run, and `AC3.md`, `AC8/notes.md` and `DET-T1/cause.md` are unchanged.
- After step 4, the only entry of `results/` whose name starts with `evidence` is `evidence` (no `evidence.next`, no aside folder).
- After step 5, `DET-T1/{base,head}` hold this run's results and `AC3.md`, `AC8/notes.md` and `DET-T1/cause.md` are unchanged.
- A test cleanup sets the mode of `AC8` back even when an assertion fails, so the fixture folder can be removed.
- Not covered: a crash of the process between the two renames of the swap. No real fault reaches it without a test-only hook in `publishEvidence`, which the authoring gate forbids; the review of the implementer step reads that branch.

## Screenshot checkpoints

none: the case compares files on disk; there is no screen.
