---
id: ARK-T481
title: "ARK-T481 close handed_off succeeds when every rule holds and removes the worktree"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: close handed_off succeeds when every rule holds and removes the worktree"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that close handed_off succeeds when every rule holds and removes the worktree. Converted on touch from ARK-304-AC5 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T481`.

## Expected results

- The test passes: close handed_off succeeds when every rule holds and removes the worktree.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
