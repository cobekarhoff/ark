---
id: ARK-T600
title: "ARK-T600 a dirty handed_off worktree and its branch stay"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup (dirty check) breaks this contract: a dirty worktree and its branch stay at close"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a dirty handed_off worktree and its branch stay. Converted on touch from ARK-294-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup (dirty check)`. It keeps ARK-167-AC2, ARK-308-AC4 too: the campaign removed the copy tests of those criteria (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T600`.

## Expected results

- The test passes: a dirty handed_off worktree and its branch stay.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
