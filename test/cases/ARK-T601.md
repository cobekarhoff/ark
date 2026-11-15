---
id: ARK-T601
title: "ARK-T601 a handed_off branch with commits stays when its worktree directory is already gone"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup (!existsSync branch) breaks this contract: the branch is kept when the worktree folder is gone"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a handed_off branch with commits stays when its worktree directory is already gone. Converted on touch from ARK-294-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup (!existsSync branch)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T601`.

## Expected results

- The test passes: a handed_off branch with commits stays when its worktree directory is already gone.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
