---
id: ARK-T607
title: "ARK-T607 cleanup of a merged run treats a branch in origin/<base> as in the target"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup (targetBranch with repoBase) breaks this contract: merged cleanup checks ancestry against origin/<base>"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that cleanup of a merged run treats a branch in origin/<base> as in the target. Converted on touch from ARK-296-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup (targetBranch with repoBase)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T607`.

## Expected results

- The test passes: cleanup of a merged run treats a branch in origin/<base> as in the target.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
