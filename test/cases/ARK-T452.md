---
id: ARK-T452
title: "ARK-T452 an open escalation request survives a passing ark test"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: an open escalation request survives a passing ark test"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an open escalation request survives a passing ark test. Converted on touch from ARK-210-AC1 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T452`.

## Expected results

- The test passes: an open escalation request survives a passing ark test.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
