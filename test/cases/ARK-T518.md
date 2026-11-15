---
id: ARK-T518
title: "ARK-T518 an unknown plan answer is refused, lists the legal answers, no event"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an unknown plan answer is refused, lists the legal answers, no event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an unknown plan answer is refused, lists the legal answers, no event. Converted on touch from ARK-153-AC5 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T518`.

## Expected results

- The test passes: an unknown plan answer is refused, lists the legal answers, no event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
