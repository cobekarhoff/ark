---
id: ARK-T613
title: "ARK-T613 worktree sync merges origin, pushes only MR worktrees and aborts conflicts"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeSync breaks this contract: worktree sync merges the target, pushes only worktrees with an MR, aborts a conflict cleanly"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree sync merges origin, pushes only MR worktrees and aborts conflicts. Converted on touch from ARK-165-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeSync`. It keeps ARK-295-AC4, ARK-296-AC3 too: the campaign removed the copy tests of those criteria (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T613`.

## Expected results

- The test passes: worktree sync merges origin, pushes only MR worktrees and aborts conflicts.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
