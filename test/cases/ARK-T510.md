---
id: ARK-T510
title: "ARK-T510 a perf run needs results/baseline.md on the first step and results/compare.md on the last"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a perf run needs results/baseline.md on the first step and results/compare.md on the last"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a perf run needs results/baseline.md on the first step and results/compare.md on the last. Converted on touch from ARK-302-AC6 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T510`.

## Expected results

- The test passes: a perf run needs results/baseline.md on the first step and results/compare.md on the last.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
