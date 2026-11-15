---
id: ARK-T632
title: "ARK-T632 a failed gh call prints unknown; a failed glab jobs call still prints ci failed; others normal"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: a failed gh call prints unknown; a failed glab jobs call still prints ci failed; others normal"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a failed gh call prints unknown; a failed glab jobs call still prints ci failed; others normal. Converted on touch from ARK-200-AC4 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request-status.test.ts` whose title starts with `ARK-T632`.

## Expected results

- The test passes: a failed gh call prints unknown; a failed glab jobs call still prints ci failed; others normal.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
