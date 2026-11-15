---
id: ARK-T586
title: "ARK-T586 anchor and create write the setting in the run worktree and keep it out of git status and git add"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts addRepoWorktree breaks this contract: worker setting `.omp/config.yml` written by anchor and kept by create, hidden from git"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that anchor and create write the setting in the run worktree and keep it out of git status and git add. Converted on touch from ARK-280-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts addRepoWorktree`. It keeps ARK-280-AC3 too: the campaign removed the copy tests of that criterion (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T586`.

## Expected results

- The test passes: anchor and create write the setting in the run worktree and keep it out of git status and git add.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
