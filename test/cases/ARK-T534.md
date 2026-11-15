---
id: ARK-T534
title: "ARK-T534 a ticket with ACs and no blockers waits in awaiting_criteria until accept"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a ticket with ACs and no blockers waits in awaiting_criteria until accept"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a ticket with ACs and no blockers waits in awaiting_criteria until accept. Converted on touch from ARK-311-AC5 by the ARK-386 campaign. It keeps ARK-170-AC3 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T534`.

## Expected results

- The test passes: a ticket with ACs and no blockers waits in awaiting_criteria until accept.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
