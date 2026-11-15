---
id: ARK-T595
title: "ARK-T595 a merged MR deletes the branch although a squash merge left it out of the target"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: 'a regression in cli/worktree.ts worktreeCleanup (mergeState === "merged") breaks this contract: merged MR state removes the branch without the ancestry check'
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a merged MR deletes the branch although a squash merge left it out of the target. Converted on touch from ARK-188-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup (mergeState === "merged")`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T595`.

## Expected results

- The test passes: a merged MR deletes the branch although a squash merge left it out of the target.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
