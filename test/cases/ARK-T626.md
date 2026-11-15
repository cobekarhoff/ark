---
id: ARK-T626
title: "ARK-T626 worktree sync refuses a none project with an invalid unrelated field before any git push or gh call"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/config.ts loadConfig, cli/worktree.ts worktreeSync breaks this contract: config is validated before any git or host call"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree sync refuses a none project with an invalid unrelated field before any git push or gh call. Converted on touch from ARK-295-AC4 by the ARK-386 campaign. Production owner: `cli/config.ts loadConfig, cli/worktree.ts worktreeSync`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T626`.

## Expected results

- The test passes: worktree sync refuses a none project with an invalid unrelated field before any git push or gh call.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
