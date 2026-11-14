---
id: ARK-T521
title: "ARK-T521 a criteria answer after awaiting_criteria is refused, no event"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a criteria answer after awaiting_criteria is refused, no event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a criteria answer after awaiting_criteria is refused, no event. Converted on touch from ARK-153-AC5 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T521`.

## Expected results

- The test passes: a criteria answer after awaiting_criteria is refused, no event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
