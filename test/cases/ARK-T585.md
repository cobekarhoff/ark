---
id: ARK-T585
title: "ARK-T585 a clean close removes workspace/ and keeps the other run files"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCleanup (rmSync of mirrorRoot) breaks this contract: close removes `workspace/` and keeps the other run files"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a clean close removes workspace/ and keeps the other run files. Converted on touch from ARK-278-AC5 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCleanup (rmSync of mirrorRoot)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T585`.

## Expected results

- The test passes: a clean close removes workspace/ and keeps the other run files.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
