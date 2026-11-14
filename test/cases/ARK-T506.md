---
id: ARK-T506
title: "ARK-T506 a full skills list passes, the React skill is allowed, and plan.md gets the Skills column with the skills"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a full skills list passes, the React skill is allowed, and plan.md gets the Skills column with the skills"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a full skills list passes, the React skill is allowed, and plan.md gets the Skills column with the skills. Converted on touch from ARK-279-AC4 by the ARK-386 campaign. It keeps ARK-328/AC1 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T506`.

## Expected results

- The test passes: a full skills list passes, the React skill is allowed, and plan.md gets the Skills column with the skills.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
