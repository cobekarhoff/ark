---
id: ARK-T425
title: "ARK-T425 evaluation record needs a known Surfaces list and stores it"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: evaluation record needs a known Surfaces list and stores it"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that evaluation record needs a known Surfaces list and stores it. Converted on touch from ARK-173-AC8 by the ARK-386 campaign. Production owner: `cli/evaluation.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T425`.

## Expected results

- The test passes: evaluation record needs a known Surfaces list and stores it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
