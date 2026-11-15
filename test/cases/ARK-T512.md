---
id: ARK-T512
title: "ARK-T512 an unknown action and a retire with no reason are refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an unknown action and a retire with no reason are refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an unknown action and a retire with no reason are refused. Converted on touch from ARK-311-AC4 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T512`.

## Expected results

- The test passes: an unknown action and a retire with no reason are refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
