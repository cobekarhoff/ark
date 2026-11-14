---
id: ARK-T609
title: "ARK-T609 workspace sync fast-forwards origin/<base> into the local <base> branch"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts workspaceSync breaks this contract: workspace sync moves a base branch that is not checked out, by fetch refspec"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that workspace sync fast-forwards origin/<base> into the local <base> branch. Converted on touch from ARK-296-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts workspaceSync`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T609`.

## Expected results

- The test passes: workspace sync fast-forwards origin/<base> into the local <base> branch.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
