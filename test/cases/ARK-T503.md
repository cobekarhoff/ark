---
id: ARK-T503
title: "ARK-T503 plan.md starts with the count of unanswered decisions before the title"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: plan.md starts with the count of unanswered decisions before the title"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan.md starts with the count of unanswered decisions before the title. Converted on touch from ARK-214-AC1 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T503`.

## Expected results

- The test passes: plan.md starts with the count of unanswered decisions before the title.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
