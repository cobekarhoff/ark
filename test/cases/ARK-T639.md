---
id: ARK-T639
title: "ARK-T639 a none project with an invalid unrelated field: open and status refuse on the config before any tool runs"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts, cli/config.ts breaks this contract: a none project with an invalid unrelated field: open and status refuse on the config before any tool runs"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a none project with an invalid unrelated field: open and status refuse on the config before any tool runs. Converted on touch from ARK-295-AC2 and ARK-295-AC3 by the ARK-386 campaign. Production owner: `cli/merge-request.ts, cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T639`.

## Expected results

- The test passes: a none project with an invalid unrelated field: open and status refuse on the config before any tool runs.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
