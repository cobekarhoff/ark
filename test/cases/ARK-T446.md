---
id: ARK-T446
title: "ARK-T446 run close records a valid outcome and refuses any other"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: run close records a valid outcome and refuses any other"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that run close records a valid outcome and refuses any other. Converted on touch from ARK-152-AC7 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T446`.

## Expected results

- The test passes: run close records a valid outcome and refuses any other.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
