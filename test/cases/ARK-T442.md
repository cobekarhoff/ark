---
id: ARK-T442
title: "ARK-T442 step start/finish are events and status shows the first unfinished step"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: step start/finish are events and status shows the first unfinished step"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that step start/finish are events and status shows the first unfinished step. Converted on touch from ARK-152-AC5 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T442`.

## Expected results

- The test passes: step start/finish are events and status shows the first unfinished step.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
