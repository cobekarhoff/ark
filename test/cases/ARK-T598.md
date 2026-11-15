---
id: ARK-T598
title: "ARK-T598 with --allow-dirty the nested worktree is created and the changed path is printed as a warning"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts checkClean (allowDirty) breaks this contract: `--allow-dirty` creates and warns"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that with --allow-dirty the nested worktree is created and the changed path is printed as a warning. Converted on touch from ARK-188-AC5 by the ARK-386 campaign. Production owner: `cli/worktree.ts checkClean (allowDirty)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T598`.

## Expected results

- The test passes: with --allow-dirty the nested worktree is created and the changed path is printed as a warning.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
