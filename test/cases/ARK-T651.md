---
id: ARK-T651
title: "ARK-T651 a valid entry passes `ark plan check`; so does a workspace with no test/cases/"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/test-case.ts, cli/plan-check.ts breaks this contract: a valid entry passes `ark plan check`; so does a workspace with no test/cases/"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a valid entry passes `ark plan check`; so does a workspace with no test/cases/. Converted on touch from ARK-311-AC7 by the ARK-386 campaign. Production owner: `cli/test-case.ts, cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-case.test.ts` whose title starts with `ARK-T651`.

## Expected results

- The test passes: a valid entry passes `ark plan check`; so does a workspace with no test/cases/.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
