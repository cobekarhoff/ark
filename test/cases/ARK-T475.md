---
id: ARK-T475
title: "ARK-T475 a bug run with several ACs needs one test run with every non-manual AC failing"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a bug run with several ACs needs one test run with every non-manual AC failing"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a bug run with several ACs needs one test run with every non-manual AC failing. Converted on touch from ARK-302-AC5 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T475`.

## Expected results

- The test passes: a bug run with several ACs needs one test run with every non-manual AC failing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
