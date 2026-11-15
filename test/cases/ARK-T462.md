---
id: ARK-T462
title: "ARK-T462 finish --failed --not-started restores the round"
level: integration
technique: "equivalence classes (one table row for each input class)"
priority: medium
risk: "the contract breaks unnoticed: finish --failed --not-started restores the round"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that finish --failed --not-started restores the round. Converted on touch from ARK-282-AC2 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T462`.

## Expected results

- The test passes: finish --failed --not-started restores the round.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
