---
id: ARK-T573
title: "ARK-T573 with no repos named, the repos of the last valid plan are used"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts reposOfLastValidPlan, worktreeCreate breaks this contract: create with no repos reads the last valid plan; refuses with none"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that with no repos named, the repos of the last valid plan are used. Converted on touch from ARK-154-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts reposOfLastValidPlan, worktreeCreate`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T573`.

## Expected results

- The test passes: with no repos named, the repos of the last valid plan are used.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
