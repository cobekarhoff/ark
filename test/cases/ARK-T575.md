---
id: ARK-T575
title: "ARK-T575 an unknown repo among valid ones creates nothing"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCreate (repo loop before addRepoWorktree) breaks this contract: repo check runs before any worktree or event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an unknown repo among valid ones creates nothing. Converted on touch from ARK-154-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCreate (repo loop before addRepoWorktree)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T575`.

## Expected results

- The test passes: an unknown repo among valid ones creates nothing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
