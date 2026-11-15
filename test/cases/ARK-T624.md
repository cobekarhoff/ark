---
id: ARK-T624
title: "ARK-T624 sync with one conflicting repo records a conflict for that repo only"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeSync, cli/events.ts deriveState breaks this contract: per-repo `worktree.synced` conflict and `sync_conflicts`"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that sync with one conflicting repo records a conflict for that repo only. Converted on touch from ARK-241-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeSync, cli/events.ts deriveState`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T624`.

## Expected results

- The test passes: sync with one conflicting repo records a conflict for that repo only.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
