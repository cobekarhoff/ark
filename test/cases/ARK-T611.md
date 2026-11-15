---
id: ARK-T611
title: "ARK-T611 an aborted run whose base is not recorded keeps its branch"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts handedOffReason breaks this contract: an uncountable branch is kept with `could not count`"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an aborted run whose base is not recorded keeps its branch. Converted on touch from ARK-308-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts handedOffReason`. It keeps ARK-294-AC3 too: the campaign removed the copy tests of that criterion (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T611`.

## Expected results

- The test passes: an aborted run whose base is not recorded keeps its branch.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
