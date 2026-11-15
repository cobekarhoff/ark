---
id: ARK-T468
title: "ARK-T468 status skips a gone worktree and says tested nothing"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: status skips a gone worktree and says tested nothing"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status skips a gone worktree and says tested nothing. Converted on touch from ARK-287-AC2 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T468`.

## Expected results

- The test passes: status skips a gone worktree and says tested nothing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
