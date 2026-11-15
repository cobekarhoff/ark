---
id: ARK-T420
title: "ARK-T420 plan.md renders open and chosen decisions"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: plan.md renders open and chosen decisions"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan.md renders open and chosen decisions. Converted on touch from ARK-173-AC2 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T420`.

## Expected results

- The test passes: plan.md renders open and chosen decisions.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
