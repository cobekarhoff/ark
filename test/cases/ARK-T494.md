---
id: ARK-T494
title: "ARK-T494 each malformed or legacy test case scenario (empty/missing/malformed when, then, given; old steps; no expected) is refused by case name"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: each malformed or legacy test case scenario (empty/missing/malformed when, then, given; old steps; no expected) is refused by case name"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that each malformed or legacy test case scenario (empty/missing/malformed when, then, given; old steps; no expected) is refused by case name. Converted on touch from ARK-172-AC1 by the ARK-386 campaign. Production owner: `cli/plan.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T494`.

## Expected results

- The test passes: each malformed or legacy test case scenario (empty/missing/malformed when, then, given; old steps; no expected) is refused by case name.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
