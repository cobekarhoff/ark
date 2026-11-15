---
id: ARK-T640
title: "ARK-T640 open refuses a criterion that is missing or failing in the last test.completed"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: open refuses a criterion that is missing or failing in the last test.completed"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that open refuses a criterion that is missing or failing in the last test.completed. Converted on touch from ARK-302-AC2 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T640`.

## Expected results

- The test passes: open refuses a criterion that is missing or failing in the last test.completed.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
