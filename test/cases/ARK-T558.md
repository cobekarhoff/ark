---
id: ARK-T558
title: "ARK-T558 ark test exits non-zero when a unit suite fails even though every AC passes"
level: integration
technique: "state transition (suite passes or fails with every AC passing)"
priority: medium
risk: "a failing non-AC suite is ignored and a run with a red suite reads as passed"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark test exits non-zero when a unit suite fails even though every AC passes. Converted on touch from ARK-154-AC6 by the ARK-386 campaign. Production owner: `cli/test-run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T558`.

## Expected results

- The test passes: ark test exits non-zero when a unit suite fails even though every AC passes.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
