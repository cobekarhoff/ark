---
id: ARK-T593
title: "ARK-T593 a branch that exists locally makes the new branch get suffix -2, recorded in worktree.created"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts freeBranchName, branchTakenAt breaks this contract: free branch name skips a local branch"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a branch that exists locally makes the new branch get suffix -2, recorded in worktree.created. Converted on touch from ARK-188-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts freeBranchName, branchTakenAt`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T593`.

## Expected results

- The test passes: a branch that exists locally makes the new branch get suffix -2, recorded in worktree.created.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
