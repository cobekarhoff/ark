---
id: ARK-T608
title: "ARK-T608 cleanup of a merged run with no base keeps the origin/HEAD target"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup breaks this contract: merged cleanup keeps a branch that is not in the target"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that cleanup of a merged run with no base keeps the origin/HEAD target. Converted on touch from ARK-296-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup`. It keeps ARK-167-AC2 too: the campaign removed the copy tests of that criterion (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T608`.

## Expected results

- The test passes: cleanup of a merged run with no base keeps the origin/HEAD target.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
