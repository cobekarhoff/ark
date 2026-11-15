---
id: ARK-T596
title: "ARK-T596 a failed fetch with an unknown MR state keeps the branch and names the repo and the reason"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup breaks this contract: fetch failure with unknown MR state keeps the branch and names the cause"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a failed fetch with an unknown MR state keeps the branch and names the repo and the reason. Converted on touch from ARK-188-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T596`.

## Expected results

- The test passes: a failed fetch with an unknown MR state keeps the branch and names the repo and the reason.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
