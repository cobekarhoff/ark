---
id: ARK-T589
title: "ARK-T589 a nested worktree lists the mirror path of each root skills folder, the root worktree and a workspace without skills list none"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts addRepoWorktree (SKILL_DIRECTORIES) breaks this contract: nested worktree setting lists the root skill folders"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a nested worktree lists the mirror path of each root skills folder, the root worktree and a workspace without skills list none. Converted on touch from ARK-297-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts addRepoWorktree (SKILL_DIRECTORIES)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T589`.

## Expected results

- The test passes: a nested worktree lists the mirror path of each root skills folder, the root worktree and a workspace without skills list none.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
