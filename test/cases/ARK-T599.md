---
id: ARK-T599
title: "ARK-T599 closing handed_off keeps a committed branch, removes the worktree and workspace, and prints a kept line"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup, handedOffReason breaks this contract: handed_off keeps a branch with commits, removes the worktree and `workspace/`"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that closing handed_off keeps a committed branch, removes the worktree and workspace, and prints a kept line. Converted on touch from ARK-294-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup, handedOffReason`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T599`.

## Expected results

- The test passes: closing handed_off keeps a committed branch, removes the worktree and workspace, and prints a kept line.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
