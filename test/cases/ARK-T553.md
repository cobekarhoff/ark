---
id: ARK-T553
title: "ARK-T553 after an amend, approve waits for a new plan check and plan.md lists Old and New"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: after an amend, approve waits for a new plan check and plan.md lists Old and New"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that after an amend, approve waits for a new plan check and plan.md lists Old and New. Converted on touch from ARK-207-AC3 by the ARK-386 campaign. It keeps ARK-308-AC3 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/criteria-amend.test.ts` whose title starts with `ARK-T553`.

## Expected results

- The test passes: after an amend, approve waits for a new plan check and plan.md lists Old and New.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
