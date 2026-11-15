---
id: ARK-T424
title: "ARK-T424 plan check refuses with no strategy.recorded and during the strategy wait"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: plan check refuses with no strategy.recorded and during the strategy wait"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan check refuses with no strategy.recorded and during the strategy wait. Converted on touch from ARK-173-AC7 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T424`.

## Expected results

- The test passes: plan check refuses with no strategy.recorded and during the strategy wait.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
