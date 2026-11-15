---
id: ARK-T594
title: "ARK-T594 branches that exist only on origin are skipped: the lowest free suffix is used"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts branchTakenAt breaks this contract: free branch name skips origin-only branches"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that branches that exist only on origin are skipped: the lowest free suffix is used. Converted on touch from ARK-188-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts branchTakenAt`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T594`.

## Expected results

- The test passes: branches that exist only on origin are skipped: the lowest free suffix is used.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
