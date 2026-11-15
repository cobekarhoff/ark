---
id: ARK-T470
title: "ARK-T470 open project and project with no ark.yml print the plain MR line"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: open project and project with no ark.yml print the plain MR line"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that open project and project with no ark.yml print the plain MR line. Converted on touch from ARK-295-AC5 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T470`.

## Expected results

- The test passes: open project and project with no ark.yml print the plain MR line.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
