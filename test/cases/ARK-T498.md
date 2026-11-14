---
id: ARK-T498
title: "ARK-T498 the Design section sits between Summary and Steps with approach, callers table and fenced example"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: the Design section sits between Summary and Steps with approach, callers table and fenced example"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that the Design section sits between Summary and Steps with approach, callers table and fenced example. Converted on touch from ARK-171-AC3, ARK-171-AC5 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T498`.

## Expected results

- The test passes: the Design section sits between Summary and Steps with approach, callers table and fenced example.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
