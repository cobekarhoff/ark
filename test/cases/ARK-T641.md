---
id: ARK-T641
title: "ARK-T641 a manual criterion whose status is `manual ok` does not trip the per-AC refusal"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: a manual criterion whose status is `manual ok` does not trip the per-AC refusal"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a manual criterion whose status is `manual ok` does not trip the per-AC refusal. Converted on touch from ARK-302-AC2 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T641`.

## Expected results

- The test passes: a manual criterion whose status is `manual ok` does not trip the per-AC refusal.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
