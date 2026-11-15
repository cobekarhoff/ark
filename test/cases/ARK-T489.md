---
id: ARK-T489
title: "ARK-T489 each structural plan refusal (cycle, ghost need, duplicate id, no repo/role/harness/model, unknown role, unit level, unknown criterion) names its problem and writes no plan.md"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: each structural plan refusal (cycle, ghost need, duplicate id, no repo/role/harness/model, unknown role, unit level, unknown criterion) names its problem and writes no plan.md"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that each structural plan refusal (cycle, ghost need, duplicate id, no repo/role/harness/model, unknown role, unit level, unknown criterion) names its problem and writes no plan.md. Converted on touch from ARK-153-AC2 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T489`.

## Expected results

- The test passes: each structural plan refusal (cycle, ghost need, duplicate id, no repo/role/harness/model, unknown role, unit level, unknown criterion) names its problem and writes no plan.md.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
