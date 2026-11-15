---
id: ARK-T497
title: "ARK-T497 a plan with no design, empty interfaces, or an interface with no or empty callers is refused and names it"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a plan with no design, empty interfaces, or an interface with no or empty callers is refused and names it"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a plan with no design, empty interfaces, or an interface with no or empty callers is refused and names it. Converted on touch from ARK-171-AC1 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T497`.

## Expected results

- The test passes: a plan with no design, empty interfaces, or an interface with no or empty callers is refused and names it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
