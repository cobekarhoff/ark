---
id: ARK-T572
title: "ARK-T572 a single-repo workspace gets one worktree and no symlinks"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts linkUntouched (early return) breaks this contract: single-repo workspace: the worktree is the mirror, no links"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a single-repo workspace gets one worktree and no symlinks. Converted on touch from ARK-154-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts linkUntouched (early return)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T572`.

## Expected results

- The test passes: a single-repo workspace gets one worktree and no symlinks.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
