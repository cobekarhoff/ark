---
id: ARK-T469
title: "ARK-T469 spent budget + failed test is escalation; a passing test at a new head returns to building"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: spent budget + failed test is escalation; a passing test at a new head returns to building"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that spent budget + failed test is escalation; a passing test at a new head returns to building. Converted on touch from ARK-287-AC3 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T469`.

## Expected results

- The test passes: spent budget + failed test is escalation; a passing test at a new head returns to building.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
