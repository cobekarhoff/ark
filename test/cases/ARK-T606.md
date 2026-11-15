---
id: ARK-T606
title: "ARK-T606 worktree create with a later repo whose base fetch fails makes no worktree, branch or event for the earlier repo"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCreate (bases map) breaks this contract: every base fetch runs before the first worktree add"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree create with a later repo whose base fetch fails makes no worktree, branch or event for the earlier repo. Converted on touch from ARK-296-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCreate (bases map)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T606`.

## Expected results

- The test passes: worktree create with a later repo whose base fetch fails makes no worktree, branch or event for the earlier repo.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
