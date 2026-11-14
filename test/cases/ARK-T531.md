---
id: ARK-T531
title: "ARK-T531 a manual answer in planning is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a manual answer in planning is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a manual answer in planning is refused. Converted on touch from ARK-283-AC2 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T531`.

## Expected results

- The test passes: a manual answer in planning is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
