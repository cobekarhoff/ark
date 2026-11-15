---
id: ARK-T507
title: "ARK-T507 with surfaces none, skills are not checked and plan.md has no Skills column"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: with surfaces none, skills are not checked and plan.md has no Skills column"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that with surfaces none, skills are not checked and plan.md has no Skills column. Converted on touch from ARK-279-AC4 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T507`.

## Expected results

- The test passes: with surfaces none, skills are not checked and plan.md has no Skills column.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
