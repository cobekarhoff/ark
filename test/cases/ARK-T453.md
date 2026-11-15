---
id: ARK-T453
title: "ARK-T453 ark escalate below the budget exits 1 and logs nothing"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: ark escalate below the budget exits 1 and logs nothing"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark escalate below the budget exits 1 and logs nothing. Converted on touch from ARK-210-AC2 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T453`.

## Expected results

- The test passes: ark escalate below the budget exits 1 and logs nothing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
