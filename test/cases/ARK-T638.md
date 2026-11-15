---
id: ARK-T638
title: "ARK-T638 `merge_requests: none`: status prints `merge requests: none` and calls no host tool"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts, cli/config.ts breaks this contract: `merge_requests: none`: status prints `merge requests: none` and calls no host tool"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that `merge_requests: none`: status prints `merge requests: none` and calls no host tool. Converted on touch from ARK-295-AC3 by the ARK-386 campaign. Production owner: `cli/merge-request.ts, cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T638`.

## Expected results

- The test passes: `merge_requests: none`: status prints `merge requests: none` and calls no host tool.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
