---
id: ARK-T430
title: "ARK-T430 run start makes the run folder, copies the ticket, logs run.started, numbers same-day runs"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: run start makes the run folder, copies the ticket, logs run.started, numbers same-day runs"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that run start makes the run folder, copies the ticket, logs run.started, numbers same-day runs. Converted on touch from ARK-152-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T430`.

## Expected results

- The test passes: run start makes the run folder, copies the ticket, logs run.started, numbers same-day runs.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
