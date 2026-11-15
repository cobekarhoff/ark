---
id: ARK-T602
title: "ARK-T602 worktree create fetches origin/<base> and starts from it, not from the clone HEAD"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts resolveBase, worktreeCreate breaks this contract: create starts from fetched origin/<base>"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree create fetches origin/<base> and starts from it, not from the clone HEAD. Converted on touch from ARK-296-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts resolveBase, worktreeCreate`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T602`.

## Expected results

- The test passes: worktree create fetches origin/<base> and starts from it, not from the clone HEAD.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
