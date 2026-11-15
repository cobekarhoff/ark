---
id: ARK-T460
title: "ARK-T460 run close keeps an active dispatch and says so"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: run close keeps an active dispatch and says so"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that run close keeps an active dispatch and says so. Converted on touch from ARK-278-AC2 by the ARK-386 campaign. Production owner: `cli/orca-release.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T460`.

## Expected results

- The test passes: run close keeps an active dispatch and says so.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
