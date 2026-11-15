---
id: ARK-T485
title: "ARK-T485 valid plan exits 0 and plan.checked holds valid, problems, hash and steps"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: valid plan exits 0 and plan.checked holds valid, problems, hash and steps"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that valid plan exits 0 and plan.checked holds valid, problems, hash and steps. Converted on touch from ARK-153-AC1 by the ARK-386 campaign. It keeps ARK-185-AC2, ARK-302-AC5 too: the copy tests of those criteria were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T485`.

## Expected results

- The test passes: valid plan exits 0 and plan.checked holds valid, problems, hash and steps.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
