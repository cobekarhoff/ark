---
id: ARK-T576
title: "ARK-T576 worktree branches use a lowercase title slug capped at 40 characters"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts baseBranchName breaks this contract: branch name format"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree branches use a lowercase title slug capped at 40 characters. Converted on touch from ARK-167-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts baseBranchName`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T576`.

## Expected results

- The test passes: worktree branches use a lowercase title slug capped at 40 characters.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
