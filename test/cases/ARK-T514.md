---
id: ARK-T514
title: "ARK-T514 a verified_by id that is not active and not added is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a verified_by id that is not active and not added is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a verified_by id that is not active and not added is refused. Converted on touch from ARK-311-AC4 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T514`.

## Expected results

- The test passes: a verified_by id that is not active and not added is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
