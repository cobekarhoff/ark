---
id: ARK-T625
title: "ARK-T625 worktree sync never pushes for a none project, also with a stray merge_request.opened event"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeSync (mode none) breaks this contract: a `merge_requests: none` project never pushes on sync, even with an MR event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree sync never pushes for a none project, also with a stray merge_request.opened event. Converted on touch from ARK-295-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeSync (mode none)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T625`.

## Expected results

- The test passes: worktree sync never pushes for a none project, also with a stray merge_request.opened event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
