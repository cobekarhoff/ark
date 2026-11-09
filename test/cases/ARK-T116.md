---
id: ARK-T116
title: ARK-T116 a none project lists each branch with commits beyond its base, before and after handed_off
level: integration
technique: state transition (no commit, commits, handed_off with worktree removed), boundary of zero commits
priority: medium
risk: "a `merge_requests: none` run hides its branch, counts the wrong commits against the base, or loses the kept branch once `handed_off` removes the worktree, so the human cannot find the work to merge"
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that `ark status <run>` on a `merge_requests: none` project prints `merge requests: none (local only)` and one `branch` line per branch with commits beyond its base, and that the line is the same after `ark run close <run> handed_off` has removed the worktree.

## Preconditions

- A fixture project with `merge_requests: none` and a run with a real worktree and a `worktree.created` event holding the branch and the 40-character base. Real `ark`, real git, no mocks.

## Steps

1. Before any commit, run `ark status <run>`.
2. Commit twice in the worktree and run `ark status <run>` again.
3. Run `ark test <run>`, then `ark run close <run> handed_off`, then `ark status <run>`.

## Expected results

- With no commit, the exit code shall be 0, the output shall hold `merge requests: none (local only)` and no `branch` line.
- With two commits, the output shall hold `branch   1  .   <branch>   2 commit(s) ahead of <first 8 characters of the base>` directly under the local-only line.
- After `handed_off`, the worktree shall be gone, the exit code shall be 0, and the same `branch` line shall print.

## Screenshot checkpoints

none: integration case on command output.
