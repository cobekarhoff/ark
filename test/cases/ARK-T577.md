---
id: ARK-T577
title: "ARK-T577 closing an abandoned run removes a clean worktree and its branch"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup breaks this contract: close `abandoned` removes a clean worktree and its branch"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that closing an abandoned run removes a clean worktree and its branch. Converted on touch from ARK-167-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T577`.

## Expected results

- The test passes: closing an abandoned run removes a clean worktree and its branch.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
