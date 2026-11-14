---
id: ARK-T421
title: "ARK-T421 open decisions are counted and block plan approve"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: open decisions are counted and block plan approve"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that open decisions are counted and block plan approve. Converted on touch from ARK-173-AC3 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T421`.

## Expected results

- The test passes: open decisions are counted and block plan approve.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
