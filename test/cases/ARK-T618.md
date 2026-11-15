---
id: ARK-T618
title: "ARK-T618 sync records a conflict before failing and a later clean sync clears it"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeSync, cli/run.ts merge guard breaks this contract: a sync conflict is recorded before the exit and a clean sync clears it"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that sync records a conflict before failing and a later clean sync clears it. Converted on touch from ARK-211-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeSync, cli/run.ts merge guard`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T618`.

## Expected results

- The test passes: sync records a conflict before failing and a later clean sync clears it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
