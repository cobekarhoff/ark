---
id: ARK-T445
title: "ARK-T445 status of one run shows phase, round, waiting gate and cost"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: status of one run shows phase, round, waiting gate and cost"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status of one run shows phase, round, waiting gate and cost. Converted on touch from ARK-152-AC6 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T445`.

## Expected results

- The test passes: status of one run shows phase, round, waiting gate and cost.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
