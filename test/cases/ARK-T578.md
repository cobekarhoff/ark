---
id: ARK-T578
title: "ARK-T578 anchor of a root-repo workspace is the run worktree, printed once and recorded once"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeAnchor breaks this contract: anchor of a root repo: `path:` line, idempotent, one event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that anchor of a root-repo workspace is the run worktree, printed once and recorded once. Converted on touch from ARK-276-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeAnchor`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T578`.

## Expected results

- The test passes: anchor of a root-repo workspace is the run worktree, printed once and recorded once.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
