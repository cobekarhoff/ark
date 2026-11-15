---
id: ARK-T458
title: "ARK-T458 ark escalate stores the reason trimmed"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: ark escalate stores the reason trimmed"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark escalate stores the reason trimmed. Converted on touch from ARK-228-AC2 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T458`.

## Expected results

- The test passes: ark escalate stores the reason trimmed.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
