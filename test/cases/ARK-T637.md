---
id: ARK-T637
title: "ARK-T637 `merge_requests: none`: open exits 1 before any git, gh or glab call"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts, cli/config.ts breaks this contract: `merge_requests: none`: open exits 1 before any git, gh or glab call"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that `merge_requests: none`: open exits 1 before any git, gh or glab call. Converted on touch from ARK-295-AC2 by the ARK-386 campaign. Production owner: `cli/merge-request.ts, cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T637`.

## Expected results

- The test passes: `merge_requests: none`: open exits 1 before any git, gh or glab call.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
