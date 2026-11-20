---
id: ARK-T471
title: "ARK-T471 a none project with an invalid unrelated field reads as open and prints `merge requests: not opened yet`"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "a none project whose ark.yml has an invalid unrelated field fails `ark status`, or prints `(local only)` or a bare `merge requests: none` instead of the open-project line `merge requests: not opened yet`"
status: active
changed_by: 2026-11-19-ARK-464-1
---

## Objective

Prove that `ark status <run>` of a `merge_requests: none` project whose ark.yml also holds an invalid unrelated field exits 0, counts the project as open, and prints `merge requests: not opened yet` for a run with no MR. Converted on touch from ARK-295-AC5 by the ARK-386 campaign; the expected line changed in ARK-464. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T471`.

## Expected results

- The test passes: the exit code is 0, the output holds the line `merge requests: not opened yet`, and it holds no `(local only)`.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
