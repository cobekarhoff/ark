---
id: ARK-T597
title: "ARK-T597 a dirty nested source repo without --allow-dirty exits 1, lists the path and creates no worktree"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts checkClean breaks this contract: dirty nested source refused before any worktree"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a dirty nested source repo without --allow-dirty exits 1, lists the path and creates no worktree. Converted on touch from ARK-188-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts checkClean`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T597`.

## Expected results

- The test passes: a dirty nested source repo without --allow-dirty exits 1, lists the path and creates no worktree.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
