---
id: ARK-T499
title: "ARK-T499 a missing approach or example prints its placeholder, each on its own"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a missing approach or example prints its placeholder, each on its own"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a missing approach or example prints its placeholder, each on its own. Converted on touch from ARK-171-AC4 by the ARK-386 campaign. It keeps ARK-171-AC2 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T499`.

## Expected results

- The test passes: a missing approach or example prints its placeholder, each on its own.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
