---
id: ARK-T488
title: "ARK-T488 plan check of an unknown run is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: plan check of an unknown run is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan check of an unknown run is refused. Converted on touch from ARK-153-AC1 by the ARK-386 campaign. Production owner: `cli/paths.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T488`.

## Expected results

- The test passes: plan check of an unknown run is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
