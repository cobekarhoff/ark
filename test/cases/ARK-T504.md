---
id: ARK-T504
title: "ARK-T504 the decisions line goes once every decision is answered"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: the decisions line goes once every decision is answered"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that the decisions line goes once every decision is answered. Converted on touch from ARK-214-AC2 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T504`.

## Expected results

- The test passes: the decisions line goes once every decision is answered.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
