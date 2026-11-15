---
id: ARK-T438
title: "ARK-T438 run start refuses a project with no ark.yml"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: run start refuses a project with no ark.yml"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that run start refuses a project with no ark.yml. Converted on touch from ARK-152-AC2 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T438`.

## Expected results

- The test passes: run start refuses a project with no ark.yml.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
