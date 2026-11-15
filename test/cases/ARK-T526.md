---
id: ARK-T526
title: "ARK-T526 plan change stays in planning, plan abort closes the run"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: plan change stays in planning, plan abort closes the run"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan change stays in planning, plan abort closes the run. Converted on touch from ARK-153-AC6 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T526`.

## Expected results

- The test passes: plan change stays in planning, plan abort closes the run.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
