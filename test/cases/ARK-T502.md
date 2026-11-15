---
id: ARK-T502
title: "ARK-T502 a fenced example keeps the Steps heading and table outside every fence"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a fenced example keeps the Steps heading and table outside every fence"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a fenced example keeps the Steps heading and table outside every fence. Converted on touch from ARK-185-AC3 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T502`.

## Expected results

- The test passes: a fenced example keeps the Steps heading and table outside every fence.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
