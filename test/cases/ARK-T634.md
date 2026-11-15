---
id: ARK-T634
title: "ARK-T634 repoGraph order follows needs across repos, ties by first appearance, deterministic"
level: unit
technique: "equivalence classes through the public repoGraph function"
priority: medium
risk: "a regression in cli/plan.ts breaks this contract: repoGraph order follows needs across repos, ties by first appearance, deterministic"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that repoGraph order follows needs across repos, ties by first appearance, deterministic. Converted on touch from ARK-155-AC2 by the ARK-386 campaign. Production owner: `cli/plan.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T634`.

## Expected results

- The test passes: repoGraph order follows needs across repos, ties by first appearance, deterministic.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
