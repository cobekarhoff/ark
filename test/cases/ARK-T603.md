---
id: ARK-T603
title: "ARK-T603 worktree anchor starts from origin/<base> and records it as worktree.created.base"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts addRepoWorktree (`resolvedBase ?? resolveBase`) breaks this contract: anchor starts from origin/<base>"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree anchor starts from origin/<base> and records it as worktree.created.base. Converted on touch from ARK-296-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts addRepoWorktree (`resolvedBase ?? resolveBase`)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T603`.

## Expected results

- The test passes: worktree anchor starts from origin/<base> and records it as worktree.created.base.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
