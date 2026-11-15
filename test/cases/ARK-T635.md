---
id: ARK-T635
title: "ARK-T635 repoGraph refuses a dependency cycle between repos"
level: unit
technique: "equivalence classes through the public repoGraph function"
priority: medium
risk: "a regression in cli/plan.ts breaks this contract: repoGraph refuses a dependency cycle between repos"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that repoGraph refuses a dependency cycle between repos. Converted on touch from ARK-155-AC2 by the ARK-386 campaign. Production owner: `cli/plan.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T635`.

## Expected results

- The test passes: repoGraph refuses a dependency cycle between repos.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
