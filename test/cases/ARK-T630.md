---
id: ARK-T630
title: "ARK-T630 --since with an unparseable time is refused"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: --since with an unparseable time is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --since with an unparseable time is refused. Converted on touch from ARK-200-AC2 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request-status.test.ts` whose title starts with `ARK-T630`.

## Expected results

- The test passes: --since with an unparseable time is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
