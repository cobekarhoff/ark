---
id: ARK-T583
title: "ARK-T583 closing keeps a root anchor that holds real untracked files next to a nested worktree, and deletes nothing"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts dirtyLines, worktreeCleanup breaks this contract: dirty check of a root counts real files and ignores nested worktrees"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that closing keeps a root anchor that holds real untracked files next to a nested worktree, and deletes nothing. Converted on touch from ARK-276-AC5 by the ARK-386 campaign. Production owner: `cli/worktree.ts dirtyLines, worktreeCleanup`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T583`.

## Expected results

- The test passes: closing keeps a root anchor that holds real untracked files next to a nested worktree, and deletes nothing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
