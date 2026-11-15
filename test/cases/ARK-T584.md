---
id: ARK-T584
title: "ARK-T584 the printed anchor path is a real path under the run folder"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeAnchor, cli/paths.ts breaks this contract: the printed anchor path is a resolved real path under the run folder"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that the printed anchor path is a real path under the run folder. Converted on touch from ARK-276-AC9 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeAnchor, cli/paths.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T584`.

## Expected results

- The test passes: the printed anchor path is a real path under the run folder.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
