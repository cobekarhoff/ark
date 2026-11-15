---
id: ARK-T530
title: "ARK-T530 a manual answer other than ok or problem, or with no criterion, is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a manual answer other than ok or problem, or with no criterion, is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a manual answer other than ok or problem, or with no criterion, is refused. Converted on touch from ARK-283-AC2 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T530`.

## Expected results

- The test passes: a manual answer other than ok or problem, or with no criterion, is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
