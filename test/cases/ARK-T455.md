---
id: ARK-T455
title: "ARK-T455 one_more_round after escalate returns to building and starts round 3"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: one_more_round after escalate returns to building and starts round 3"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that one_more_round after escalate returns to building and starts round 3. Converted on touch from ARK-210-AC3 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T455`.

## Expected results

- The test passes: one_more_round after escalate returns to building and starts round 3.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
