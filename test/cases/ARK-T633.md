---
id: ARK-T633
title: "ARK-T633 open refuses when the last test run did not pass"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: open refuses when the last test run did not pass"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that open refuses when the last test run did not pass. Converted on touch from ARK-155-AC6 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T633`.

## Expected results

- The test passes: open refuses when the last test run did not pass.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
