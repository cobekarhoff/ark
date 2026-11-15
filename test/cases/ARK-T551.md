---
id: ARK-T551
title: "ARK-T551 a second amend records the first amended text as old"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a second amend records the first amended text as old"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a second amend records the first amended text as old. Converted on touch from ARK-207-AC1 by the ARK-386 campaign. Production owner: `cli/criteria.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/criteria-amend.test.ts` whose title starts with `ARK-T551`.

## Expected results

- The test passes: a second amend records the first amended text as old.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
