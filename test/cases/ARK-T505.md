---
id: ARK-T505
title: "ARK-T505 a non-empty skills list that lacks a required skill is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a non-empty skills list that lacks a required skill is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a non-empty skills list that lacks a required skill is refused. Converted on touch from ARK-279-AC4 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T505`.

## Expected results

- The test passes: a non-empty skills list that lacks a required skill is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
