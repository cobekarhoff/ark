---
id: ARK-T542
title: "ARK-T542 status and metrics.json count auto and human answers apart"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: status and metrics.json count auto and human answers apart"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status and metrics.json count auto and human answers apart. Converted on touch from ARK-234-AC5 by the ARK-386 campaign. It keeps ARK-288-AC7 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/retro.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T542`.

## Expected results

- The test passes: status and metrics.json count auto and human answers apart.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
