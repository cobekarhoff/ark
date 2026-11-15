---
id: ARK-T516
title: "ARK-T516 an old-scheme AC needs one integration or e2e case"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: an old-scheme AC needs one integration or e2e case"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an old-scheme AC needs one integration or e2e case. Converted on touch from ARK-311-AC4 by the ARK-386 campaign. It keeps ARK-153-AC3 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T516`.

## Expected results

- The test passes: an old-scheme AC needs one integration or e2e case.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
