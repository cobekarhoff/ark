---
id: ARK-T471
title: "ARK-T471 a none project with an invalid unrelated field reads as open"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a none project with an invalid unrelated field reads as open"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a none project with an invalid unrelated field reads as open. Converted on touch from ARK-295-AC5 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T471`.

## Expected results

- The test passes: a none project with an invalid unrelated field reads as open.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
