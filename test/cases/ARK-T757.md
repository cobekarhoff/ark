---
id: ARK-T757
title: ARK-T757 The next ark test puts back the evidence a crashed swap parked in evidence.old, and drops an aside folder that a finished swap left
level: integration
technique: state transition (crash between the two renames of the publish, then a quick or full run), error guessing (an aside folder beside a live evidence folder)
priority: high
risk: A crash between the two renames of the publish leaves results/evidence missing and the old tree in results/evidence.old; if the next run does not restore it, the old worker files (AC3.md, AC8/notes.md, cause.md) and the base/head of every case are lost, and the aside folder stays beside the new evidence for good
status: active
changed_by: 2026-11-20-ARK-614-1
---

## Objective

Prove that the run start of `ark test` restores `results/evidence.old` when `results/evidence` is missing, removes it when `results/evidence` exists, and that no `evidence*` entry but `evidence` stays. Serves ARK-614 AC2 (the swap puts the old evidence back; a crash in it loses nothing).

Expected: When `results/evidence.old` exists at the start of an `ark test` and `results/evidence` does not, the system shall rename it to `results/evidence` before the run writes anything; when both exist, the system shall remove `results/evidence.old`.

## Preconditions

- The evidence fixture of `test/detached-runner.test.ts` (`evidenceFixture(false)`), with a finished full `ark test` (exit 0).
- Written by hand into `results/evidence/`: `AC3.md`, `AC8/notes.md` and `DET-T1/cause.md`.

## Steps

1. Record the tree of `results/evidence` with `treeOf`.
2. Crash state: rename `results/evidence` to `results/evidence.old`, so that `results/evidence` is missing. Run a quick `ark test <run>` and wait for exit 0. Record the tree and list `results/`.
3. Crash state again (the same rename). Commit a change to the mirror and run a full `ark test <run>` and wait for exit 0. Record the tree and list `results/`.
4. Make `results/evidence.old` a folder with one file, while `results/evidence` exists (a finished swap whose last removal crashed). Run a full `ark test <run>` and wait for exit 0. List `results/`.

## Expected results

- After step 2 the tree equals that of step 1, and the only entry of `results/` whose name starts with `evidence` is `evidence`.
- After step 3, `AC3.md`, `AC8/notes.md` and `DET-T1/cause.md` are unchanged, `DET-T1/{base,head}` hold this run's results (the head `result.json` differs from step 1), and the only `evidence*` entry is `evidence`.
- After step 4, the same files are unchanged and the only `evidence*` entry is `evidence`.
- Not covered: the put-back of the old folder when the second rename of the publish fails. Both renames work in `results/` on one file system, so no permission, mode or full disk breaks the second and not the first (a `chmod` on `results/` fails the first rename and leaves the old folder in place; the staging folder is created by the run itself, so a test cannot give it a bad mode). A test needs a hook in `publishEvidence` that only it calls, which the authoring gate forbids; the review of the implementer step reads that branch.

## Screenshot checkpoints

none: the case compares files on disk; there is no screen.
