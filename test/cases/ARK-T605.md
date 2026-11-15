---
id: ARK-T605
title: "ARK-T605 worktree create and worktree anchor with a base origin lacks exit 1, name the repo and the fetch error, and make nothing"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts resolveBase breaks this contract: a failed base fetch exits 1, names the repo and git's error, makes nothing (create and anchor)"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree create and worktree anchor with a base origin lacks exit 1, name the repo and the fetch error, and make nothing. Converted on touch from ARK-296-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts resolveBase`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T605`.

## Expected results

- The test passes: worktree create and worktree anchor with a base origin lacks exit 1, name the repo and the fetch error, and make nothing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
