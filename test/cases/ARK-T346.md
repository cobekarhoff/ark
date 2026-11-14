---
id: ARK-T346
title: ARK-T346 ark test fails a run whose diff touches a test with a case id that the plan's test_cases does not list, and the message names the id, the file and the fix
level: integration
technique: equivalence classes (listed id, unlisted id) over ids in one diff
priority: high
risk: "a touched case id missing from the plan passes ark test; only the first id of a title is compared; an id of an enclosing describe is skipped; the same id is reported once per declaration; the message omits the id, the file or the fix; the failure does not set exit 1; a missing plan.yml crashes ark test"
status: active
changed_by: 2026-11-13-ARK-431-1
---

## Objective

Prove that `ark test <run>` rejects a touched case id that the plan does not list.

Expected: When the diff from the run's base changes a bun test whose title holds a test case id that the `test_cases` of `plan.yml` does not list, `ark test <run>` shall exit 1 and print the id, the test file and the fix: add the id to `test_cases` with the action reuse, update or retire.

## Preconditions

- Fixture project with a git repo, a base commit with a bun test file that holds tests titled `ARK-T1 ...`, `ARK-T2 ...` and `ARK-T3 ...`, and a `describe("ARK-T4 ...")` with a test inside, plus an untouched test titled `ARK-T9 ...`.
- A run whose base is that commit, as the existing `ark test` integration tests build, with a `plan.yml` whose `test_cases` lists only `ARK-T1`.
- A head commit that edits the body of the ARK-T1, ARK-T2 and ARK-T3 tests (ARK-T3 twice, in two tests), and one test inside the ARK-T4 describe.

## Steps

1. Run `ark test <run>`; read its output, its exit code and the recorded results.
2. Commit a change of the `ARK-T9` test on top (as main would), record a `worktree.synced` event whose `target_commit` is that commit, commit a new edit of the `ARK-T2` test, and run `ark test <run>` again.
3. Delete `plan.yml` from the run folder and run `ark test <run>` again.

## Expected results

- Step 1: exit 1. The output names `ARK-T2`, `ARK-T3` and `ARK-T4`, the test file path, and the fix (add the id to `test_cases` with the action reuse, update or retire). `ARK-T1` and the untouched `ARK-T9` are not named. `ARK-T3` appears once for the file, not once for each test. The failure shows in the recorded checks of `test.completed`, next to the old id check.
- Step 2: only `ARK-T2` is named. The ids that the run changed before the synced commit (`ARK-T3` to `ARK-T6`) and `ARK-T9`, which main changed, are not named: the check diffs from the newest synced target commit, else the created base.
- Step 3: `ark test` does not crash; it prints a skip line for the check and the suite results decide the exit code.

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
