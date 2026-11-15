---
id: ARK-T522
title: "ARK-T522 an escalation answer while the round budget is unspent is refused, no event"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an escalation answer while the round budget is unspent is refused, no event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an escalation answer while the round budget is unspent is refused, no event. Converted on touch from ARK-153-AC5 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T522`.

## Expected results

- The test passes: an escalation answer while the round budget is unspent is refused, no event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
