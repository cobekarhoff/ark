---
id: ARK-T457
title: "ARK-T457 escalate after an answered one_more_round opens the gate again"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: escalate after an answered one_more_round opens the gate again"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that escalate after an answered one_more_round opens the gate again. Converted on touch from ARK-228-AC1 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T457`.

## Expected results

- The test passes: escalate after an answered one_more_round opens the gate again.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
