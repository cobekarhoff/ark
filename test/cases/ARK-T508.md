---
id: ARK-T508
title: "ARK-T508 a bug run refuses a plan whose first step is not a validator serving every AC"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a bug run refuses a plan whose first step is not a validator serving every AC"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a bug run refuses a plan whose first step is not a validator serving every AC. Converted on touch from ARK-302-AC5 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T508`.

## Expected results

- The test passes: a bug run refuses a plan whose first step is not a validator serving every AC.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
