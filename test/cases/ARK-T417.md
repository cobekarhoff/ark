---
id: ARK-T417
title: "ARK-T417 plan check refuses a run with no evaluation.recorded"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "plan checked before the evaluation"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan check refuses a run with no evaluation.recorded. Converted on touch from ARK-170-AC4 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/evaluation.test.ts` whose title starts with `ARK-T417`.

## Expected results

- The test passes: plan check refuses a run with no evaluation.recorded.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
