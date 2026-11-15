---
id: ARK-T653
title: "ARK-T653 `ark test` refuses a bad entry in the worktree before any suite runs"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/test-case.ts, cli/test.ts breaks this contract: `ark test` refuses a bad entry in the worktree before any suite runs"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that `ark test` refuses a bad entry in the worktree before any suite runs. Converted on touch from ARK-311-AC7 by the ARK-386 campaign. Production owner: `cli/test-case.ts, cli/test.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-case.test.ts` whose title starts with `ARK-T653`.

## Expected results

- The test passes: `ark test` refuses a bad entry in the worktree before any suite runs.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
