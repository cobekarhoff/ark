---
id: ARK-T648
title: "ARK-T648 the SQC-1 ticket ACs yield the required and removed strings that merge-request open checks"
level: unit
technique: "equivalence classes through requiredLiterals on a frozen ticket fixture"
priority: medium
risk: "a regression in cli/merge-request.ts (requiredLiterals) breaks this contract: the SQC-1 ticket ACs yield the required and removed strings that merge-request open checks"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that the SQC-1 ticket ACs yield the required and removed strings that merge-request open checks. Converted on touch from ARK-305-AC3 by the ARK-386 campaign. Production owner: `cli/merge-request.ts (requiredLiterals)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T648`.

## Expected results

- The test passes: the SQC-1 ticket ACs yield the required and removed strings that merge-request open checks.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
