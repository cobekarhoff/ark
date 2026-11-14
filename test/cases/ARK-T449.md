---
id: ARK-T449
title: "ARK-T449 nothing is recorded after a run is closed"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: nothing is recorded after a run is closed"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that nothing is recorded after a run is closed. Converted on touch from ARK-152-AC7 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T449`.

## Expected results

- The test passes: nothing is recorded after a run is closed.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
