---
id: ARK-T524
title: "ARK-T524 plan approve after an invalid check is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: plan approve after an invalid check is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan approve after an invalid check is refused. Converted on touch from ARK-153-AC6 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T524`.

## Expected results

- The test passes: plan approve after an invalid check is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
