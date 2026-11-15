---
id: ARK-T533
title: "ARK-T533 ark status lists the manual criteria that are not ok"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: ark status lists the manual criteria that are not ok"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark status lists the manual criteria that are not ok. Converted on touch from ARK-283-AC2 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T533`.

## Expected results

- The test passes: ark status lists the manual criteria that are not ok.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
