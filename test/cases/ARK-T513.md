---
id: ARK-T513
title: "ARK-T513 a reuse, update or retire entry with no test/cases file is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a reuse, update or retire entry with no test/cases file is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a reuse, update or retire entry with no test/cases file is refused. Converted on touch from ARK-311-AC4 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T513`.

## Expected results

- The test passes: a reuse, update or retire entry with no test/cases file is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
