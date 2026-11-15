---
id: ARK-T472
title: "ARK-T472 retro counts the auto escalation answer and the hub timeline shows by auto"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: retro counts the auto escalation answer and the hub timeline shows by auto"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that retro counts the auto escalation answer and the hub timeline shows by auto. Converted on touch from ARK-288-AC7 by the ARK-386 campaign. Production owner: `hub/run-detail.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T472`.

## Expected results

- The test passes: retro counts the auto escalation answer and the hub timeline shows by auto.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
