---
id: ARK-T461
title: "ARK-T461 close --sweep releases closed runs once, records nothing, refuses a run argument"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: close --sweep releases closed runs once, records nothing, refuses a run argument"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that close --sweep releases closed runs once, records nothing, refuses a run argument. Converted on touch from ARK-278-AC4 by the ARK-386 campaign. It keeps ARK-278-AC7 too: the copy tests of those criteria were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T461`.

## Expected results

- The test passes: close --sweep releases closed runs once, records nothing, refuses a run argument.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
