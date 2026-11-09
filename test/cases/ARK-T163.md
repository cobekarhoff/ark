---
id: ARK-T163
title: "ARK-T163 a passed head or base result is reused with a message; a change of head, test files, suite command or mode, and a failed result, run the suite again"
level: integration
technique: equivalence classes on the cache key (head, base commit, test file hash, command, mode) with boundary on one changed component each; decision table for passed against failed
priority: high
risk: a failed result is stored and blocks the retry that clears a flake; a key that leaves out a component (second repo head, suite command, quick against full mode, test file hash) serves a stale result; or a reused result drops evidence, criterion status or base_passed
status: active
changed_by: 2026-11-09-ARK-366-1
---

## Objective

Prove that `ark test` reuses a stored passed result for the head key and for the base key, says so, restores its evidence, and that any change to a key component or a failed stored result runs the suite again.

## Preconditions

- Temporary `ARK_HOME` and git repo with two repos in the workspace, one suite whose command appends a line to a counter file on each start and writes a junit result and one evidence file.
- A feature run with a base commit and test files copied to the base run.

## Steps

1. Run `ark test <run>` (full): the counter shows one start at the head and one at the base.
2. Run `ark test <run>` again with nothing changed: read the output and the counter.
3. Read `results/evidence` and the criterion statuses after step 2 and compare with step 1.
4. Change one thing at a time, running `ark test` after each and resetting to the unchanged state (cache from steps 1-2 kept): (a) commit in the first repo, (b) commit in a touched second repo, (c) change a copied test file with the base commit unchanged, (d) change the recorded base commit with every copied test file byte-identical (move `worktree.created` to another commit that differs only in production files), (e) change the suite command.
   4f. Mode change, one isolated cache per direction (a fresh `ARK_HOME` cache each, so no entry from steps 1-4 exists): (i) run `ark test <run>` full to store a passed result, then `ark test <run> --quick`; (ii) with another fresh cache run `ark test <run> --quick` to store a passed result, then `ark test <run>` full. Nothing else changes between the two runs of a direction. Do not return to the first mode afterwards: a return to the stored mode is valid reuse (step 2).
5. Failed head, isolated from step 1-4 entries: use a head commit and a cache that hold no passed result for the suite (fresh `ARK_HOME` cache or a new head commit). Create an external failure flag file that makes the file fail on every start, so the first start and its one retry both fail. Run `ark test` and read the counter and the stored result. Then delete the flag file without changing head, base, test files, command or mode, and run `ark test` again.
6. Make a base run fail for a refactor run and run `ark test` twice.
7. Run a suite with a `checks` entry on a reused result.

## Expected results

- Step 1: counter 2 (head and base).
- Step 2: the output says reused for the head and base results with the key; the counter is unchanged; the suite process is not started and no base checkout or install runs.
- Step 3: evidence files, results and criterion statuses are equal to step 1.
- Step 4: (a)(b) start the head suite again and the base result is reused; (c) starts the base suite again, with the base commit unchanged; (d) starts the base suite again with the copied test hash unchanged and no reuse message for the base result, which proves the base commit is part of the key; (e) starts both again.
- Step 4f: in both directions the second run starts the suite again (counter grows) and prints no reuse message for the mode-changed key, because the only stored entry has the other mode.
- Step 5: the first run starts the file twice (initial start and retry), the suite fails, exit 1, and the stored head result is recorded as failed and not offered for reuse; the second run, with the same key, starts the suite again (counter grows, no `reused` message), passes, exit 0, and only then stores a passed result.
- Step 6: a failed base result runs again and `base_passed` is not taken from it.
- Step 7: the checks run on every call, reused or not.

## Screenshot checkpoints

none: integration case on CLI output, files and processes; no UI surface.
