---
id: ARK-T539
title: "ARK-T539 gates.plan auto does not answer an invalid plan"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: gates.plan auto does not answer an invalid plan"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that gates.plan auto does not answer an invalid plan. Converted on touch from ARK-234-AC2 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T539`.

## Expected results

- The test passes: gates.plan auto does not answer an invalid plan.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
