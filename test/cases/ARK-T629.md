---
id: ARK-T629
title: "ARK-T629 --since lists only human comments after the time, GitHub and GitLab; none without --since"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: --since lists only human comments after the time, GitHub and GitLab; none without --since"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --since lists only human comments after the time, GitHub and GitLab; none without --since. Converted on touch from ARK-200-AC2 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request-status.test.ts` whose title starts with `ARK-T629`.

## Expected results

- The test passes: --since lists only human comments after the time, GitHub and GitLab; none without --since.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
