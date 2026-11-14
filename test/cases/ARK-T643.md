---
id: ARK-T643
title: "ARK-T643 an AC string held only by an untouched repo of the workspace counts"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: an AC string held only by an untouched repo of the workspace counts"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an AC string held only by an untouched repo of the workspace counts. Converted on touch from ARK-302-AC3 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T643`.

## Expected results

- The test passes: an AC string held only by an untouched repo of the workspace counts.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
