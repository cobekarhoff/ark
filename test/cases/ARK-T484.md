---
id: ARK-T484
title: "ARK-T484 run start refuses a bad method, duplicate id or bad verified_by"
level: integration
technique: "equivalence classes (one table row for each input class)"
priority: medium
risk: "the contract breaks unnoticed: run start refuses a bad method, duplicate id or bad verified_by"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that run start refuses a bad method, duplicate id or bad verified_by. Converted on touch from ARK-311-AC3 by the ARK-386 campaign. Production owner: `cli/ticket.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T484`.

## Expected results

- The test passes: run start refuses a bad method, duplicate id or bad verified_by.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
