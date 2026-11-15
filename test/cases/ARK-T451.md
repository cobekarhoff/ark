---
id: ARK-T451
title: "ARK-T451 ark escalate opens the escalation gate at a spent budget with a passing test"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: ark escalate opens the escalation gate at a spent budget with a passing test"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark escalate opens the escalation gate at a spent budget with a passing test. Converted on touch from ARK-210-AC1 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T451`.

## Expected results

- The test passes: ark escalate opens the escalation gate at a spent budget with a passing test.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
