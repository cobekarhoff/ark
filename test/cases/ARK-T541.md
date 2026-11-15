---
id: ARK-T541
title: "ARK-T541 two cards with no recommended card are refused and the gate stays open"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: two cards with no recommended card are refused and the gate stays open"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that two cards with no recommended card are refused and the gate stays open. Converted on touch from ARK-234-AC3 by the ARK-386 campaign. Production owner: `cli/strategy.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T541`.

## Expected results

- The test passes: two cards with no recommended card are refused and the gate stays open.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
