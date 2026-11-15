---
id: ARK-T419
title: "ARK-T419 plan check refuses each invalid decision and names it"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: plan check refuses each invalid decision and names it"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan check refuses each invalid decision and names it. Converted on touch from ARK-173-AC1 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T419`.

## Expected results

- The test passes: plan check refuses each invalid decision and names it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
