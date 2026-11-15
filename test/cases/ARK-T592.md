---
id: ARK-T592
title: "ARK-T592 a clean root with a nested repo prints no warning and exits 0"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts dirtyLines (nested repos excluded) breaks this contract: no warning for a clean root with a nested repo"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a clean root with a nested repo prints no warning and exits 0. Converted on touch from ARK-297-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts dirtyLines (nested repos excluded)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T592`.

## Expected results

- The test passes: a clean root with a nested repo prints no warning and exits 0.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
