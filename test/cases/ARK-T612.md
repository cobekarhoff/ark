---
id: ARK-T612
title: "ARK-T612 status prints each merged MR as merged and an open MR as open"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts mergeRequestState, status print breaks this contract: `merge-request status` prints the `merged` and `open` state of each MR"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status prints each merged MR as merged and an open MR as open. Converted on touch from ARK-165-AC1 by the ARK-386 campaign. Production owner: `cli/merge-request.ts mergeRequestState, status print`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T612`.

## Expected results

- The test passes: status prints each merged MR as merged and an open MR as open.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
