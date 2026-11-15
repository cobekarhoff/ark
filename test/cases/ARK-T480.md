---
id: ARK-T480
title: "ARK-T480 a perf run with no results/compare.md is refused by close handed_off"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a perf run with no results/compare.md is refused by close handed_off"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a perf run with no results/compare.md is refused by close handed_off. Converted on touch from ARK-304-AC4 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T480`.

## Expected results

- The test passes: a perf run with no results/compare.md is refused by close handed_off.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
