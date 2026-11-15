---
id: ARK-T501
title: "ARK-T501 an empty or blank caller, also after a named one, is refused and writes no plan.md"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an empty or blank caller, also after a named one, is refused and writes no plan.md"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an empty or blank caller, also after a named one, is refused and writes no plan.md. Converted on touch from ARK-185-AC2 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T501`.

## Expected results

- The test passes: an empty or blank caller, also after a named one, is refused and writes no plan.md.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
