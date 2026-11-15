---
id: ARK-T535
title: "ARK-T535 a ticket with a blocker waits too and accept ends the wait"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a ticket with a blocker waits too and accept ends the wait"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a ticket with a blocker waits too and accept ends the wait. Converted on touch from ARK-311-AC5 by the ARK-386 campaign. It keeps ARK-170-AC2 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T535`.

## Expected results

- The test passes: a ticket with a blocker waits too and accept ends the wait.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
