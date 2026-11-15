---
id: ARK-T428
title: "ARK-T428 retro counts strategy and plan decision overrides"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: retro counts strategy and plan decision overrides"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that retro counts strategy and plan decision overrides. Converted on touch from ARK-173-AC12 by the ARK-386 campaign. Production owner: `cli/retro.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T428`.

## Expected results

- The test passes: retro counts strategy and plan decision overrides.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
