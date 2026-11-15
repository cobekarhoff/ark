---
id: ARK-T582
title: "ARK-T582 closing removes the anchor of a two-repo workspace and of a root repo with a nested worktree"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup (reverse order) breaks this contract: cleanup removes newest first, so a root anchor holding a nested worktree goes"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that closing removes the anchor of a two-repo workspace and of a root repo with a nested worktree. Converted on touch from ARK-276-AC5 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup (reverse order)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T582`.

## Expected results

- The test passes: closing removes the anchor of a two-repo workspace and of a root repo with a nested worktree.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
