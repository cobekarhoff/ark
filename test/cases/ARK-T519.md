---
id: ARK-T519
title: "ARK-T519 criteria accept re-reads the ticket, needs one criterion, records the answer and moves to planning"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: criteria accept re-reads the ticket, needs one criterion, records the answer and moves to planning"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that criteria accept re-reads the ticket, needs one criterion, records the answer and moves to planning. Converted on touch from ARK-153-AC5 by the ARK-386 campaign. It keeps ARK-170-AC3 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T519`.

## Expected results

- The test passes: criteria accept re-reads the ticket, needs one criterion, records the answer and moves to planning.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
