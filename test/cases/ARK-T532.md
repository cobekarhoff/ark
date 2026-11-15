---
id: ARK-T532
title: "ARK-T532 two manual criteria keep separate answers in state and a later answer replaces one"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: two manual criteria keep separate answers in state and a later answer replaces one"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that two manual criteria keep separate answers in state and a later answer replaces one. Converted on touch from ARK-283-AC2 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T532`.

## Expected results

- The test passes: two manual criteria keep separate answers in state and a later answer replaces one.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
