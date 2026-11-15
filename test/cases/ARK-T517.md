---
id: ARK-T517
title: "ARK-T517 an unknown gate is refused, lists the legal gates, no event"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an unknown gate is refused, lists the legal gates, no event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an unknown gate is refused, lists the legal gates, no event. Converted on touch from ARK-153-AC5 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T517`.

## Expected results

- The test passes: an unknown gate is refused, lists the legal gates, no event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
