---
id: ARK-T587
title: "ARK-T587 a meta-repo run writes the setting in each real worktree and not in a linked folder or the workspace"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts addRepoWorktree breaks this contract: the setting goes only into real worktrees, never through a link into the workspace"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a meta-repo run writes the setting in each real worktree and not in a linked folder or the workspace. Converted on touch from ARK-280-AC2, ARK-280-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts addRepoWorktree`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T587`.

## Expected results

- The test passes: a meta-repo run writes the setting in each real worktree and not in a linked folder or the workspace.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
