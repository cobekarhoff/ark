---
id: ARK-T642
title: "ARK-T642 open refuses an AC string no tracked file holds (untracked does not count), accepts one that exists"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: open refuses an AC string no tracked file holds (untracked does not count), accepts one that exists"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that open refuses an AC string no tracked file holds (untracked does not count), accepts one that exists. Converted on touch from ARK-302-AC3 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`. It keeps ARK-305-AC5 too: the campaign removed the copy test of that criterion (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T642`.

## Expected results

- The test passes: open refuses an AC string no tracked file holds (untracked does not count), accepts one that exists.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
