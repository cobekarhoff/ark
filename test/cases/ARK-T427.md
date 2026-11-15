---
id: ARK-T427
title: "ARK-T427 one-card document needs no Mockup and no designer"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: one-card document needs no Mockup and no designer"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that one-card document needs no Mockup and no designer. Converted on touch from ARK-238-AC2 by the ARK-386 campaign. It keeps ARK-279-AC3 too: the copy tests of those criteria were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/strategy.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T427`.

## Expected results

- The test passes: one-card document needs no Mockup and no designer.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
