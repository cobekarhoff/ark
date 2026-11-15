---
id: ARK-T574
title: "ARK-T574 running again keeps existing worktrees, creates missing ones and refuses unknown repos"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts addRepoWorktree (exists branch), worktreeCreate breaks this contract: create is idempotent per repo and keeps uncommitted work; unknown repo refused by name"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that running again keeps existing worktrees, creates missing ones and refuses unknown repos. Converted on touch from ARK-154-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts addRepoWorktree (exists branch), worktreeCreate`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T574`.

## Expected results

- The test passes: running again keeps existing worktrees, creates missing ones and refuses unknown repos.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
