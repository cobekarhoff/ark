---
id: ARK-T515
title: "ARK-T515 a method test AC with empty or unit-only verified_by is refused; another method is not"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a method test AC with empty or unit-only verified_by is refused; another method is not"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a method test AC with empty or unit-only verified_by is refused; another method is not. Converted on touch from ARK-311-AC4 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T515`.

## Expected results

- The test passes: a method test AC with empty or unit-only verified_by is refused; another method is not.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
