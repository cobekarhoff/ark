---
id: ARK-T610
title: "ARK-T610 aborted keeps a branch with a commit and prints the kept line, and removes a branch with none"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts handedOffReason, worktreeCleanup breaks this contract: aborted keeps a committed branch with the count line and removes an empty one"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that aborted keeps a branch with a commit and prints the kept line, and removes a branch with none. Converted on touch from ARK-308-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts handedOffReason, worktreeCleanup`. It keeps ARK-294-AC2, ARK-294-AC3 too: the campaign removed the copy tests of those criteria (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T610`.

## Expected results

- The test passes: aborted keeps a branch with a commit and prints the kept line, and removes a branch with none.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
