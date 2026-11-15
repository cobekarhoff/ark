---
id: ARK-T627
title: "ARK-T627 worktree sync merges origin/<base> of the repo, not the branch origin/HEAD names"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeSync (targetBranch with repoBase) breaks this contract: sync merges the configured base"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree sync merges origin/<base> of the repo, not the branch origin/HEAD names. Converted on touch from ARK-296-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeSync (targetBranch with repoBase)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T627`.

## Expected results

- The test passes: worktree sync merges origin/<base> of the repo, not the branch origin/HEAD names.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
