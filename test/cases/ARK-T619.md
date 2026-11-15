---
id: ARK-T619
title: "ARK-T619 retro counts merge steps in rework.merge_steps and not in rework.rounds"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/retro.ts breaks this contract: retro metrics count merge steps apart from rounds"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that retro counts merge steps in rework.merge_steps and not in rework.rounds. Converted on touch from ARK-211-AC3 by the ARK-386 campaign. Production owner: `cli/retro.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T619`.

## Expected results

- The test passes: retro counts merge steps in rework.merge_steps and not in rework.rounds.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
