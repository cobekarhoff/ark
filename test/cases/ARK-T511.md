---
id: ARK-T511
title: "ARK-T511 each test case action passes and plan.md shows the action of each case"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: each test case action passes and plan.md shows the action of each case"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that each test case action passes and plan.md shows the action of each case. Converted on touch from ARK-311-AC4 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T511`.

## Expected results

- The test passes: each test case action passes and plan.md shows the action of each case.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
