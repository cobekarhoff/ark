---
id: ARK-T423
title: "ARK-T423 one card skips the strategy gate and plan.md shows its Reason"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: one card skips the strategy gate and plan.md shows its Reason"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that one card skips the strategy gate and plan.md shows its Reason. Converted on touch from ARK-173-AC6 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T423`.

## Expected results

- The test passes: one card skips the strategy gate and plan.md shows its Reason.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
