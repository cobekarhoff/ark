---
id: ARK-T329
title: "ARK-T329 a test file that the run's diff touches and that fails always fails the run, and is never run at the tip of the target branch"
level: integration
technique: decision table (touched x fails on main) with boundary on a file that came in only through a merge-in (`ark worktree sync`)
priority: high
risk: a run that edits a test file and leaves it failing is excused because the file also fails on main; or a merge-in file is counted as the run's own, so a red-on-main file that came in through a sync spends the budget
status: active
changed_by: 2026-11-13-ARK-428-1
---

## Objective

Prove that a touched failing file is never excused by main.

## Preconditions

- Temporary `ARK_HOME` and git repo with an `origin` remote whose target branch tip holds `red.test`, which always fails.
- The run commits an edit to `red.test` (it still fails). Each start of a file appends a line to a counter file; the tip checkout writes to its own counter file.
- A second run that never edits `red.test`. The target branch gets a new commit that adds `red.test` (always fails), and the run takes it with `ark worktree sync`. The file is in the run's diff from the base only as a merge-in. The run's own commit changes `other.test` (passes).

## Steps

1. Run `ark test <run>` for the first run. Read the output, exit code, `test.completed` and the counters of the tip checkout.
2. Run `ark test <run>` for the second run. Read the same.

## Expected results

- Step 1: exit 1, `test.completed` has `passed: false` and no red-on-main field, no `red on main` line. The tip checkout is never created for `red.test`: its counter has no line.
- Step 2: the touched set is the run's own files (first-parent, no merges, from the `worktree.created` base; ARK-T119, strategy S1). A file that came in only through the sync is untouched: it is checked at the tip of the target branch, printed as a `red on main` line naming `red.test`, listed in the red-on-main field and not counted. Exit 0, `passed: true`; the tip checkout counter has a line for `red.test`.

## Screenshot checkpoints

none: integration case on CLI output, events and processes; no UI surface.
