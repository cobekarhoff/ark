---
id: ARK-T486
title: "ARK-T486 a step harness/model pair not in ark.yml roles is refused, naming the allowed pairs"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a step harness/model pair not in ark.yml roles is refused, naming the allowed pairs"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a step harness/model pair not in ark.yml roles is refused, naming the allowed pairs. Converted on touch from ARK-282-AC1 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T486`.

## Expected results

- The test passes: a step harness/model pair not in ark.yml roles is refused, naming the allowed pairs.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
