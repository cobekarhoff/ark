---
id: ARK-T588
title: "ARK-T588 anchor and create change no file in the home folders or the main workspace, including info/exclude and git config"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts addRepoWorktree breaks this contract: worktree setup touches no user home, ARK_HOME or workspace file"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that anchor and create change no file in the home folders or the main workspace, including info/exclude and git config. Converted on touch from ARK-280-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts addRepoWorktree`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T588`.

## Expected results

- The test passes: anchor and create change no file in the home folders or the main workspace, including info/exclude and git config.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
