---
id: ARK-T465
title: "ARK-T465 --not-started after a merge start keeps the real round"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: --not-started after a merge start keeps the real round"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --not-started after a merge start keeps the real round. Converted on touch from ARK-282-AC2 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T465`.

## Expected results

- The test passes: --not-started after a merge start keeps the real round.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
