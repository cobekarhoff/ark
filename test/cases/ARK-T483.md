---
id: ARK-T483
title: "ARK-T483 AC string check skips placeholder, glob, dots, file:line, own id and manual ACs"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: AC string check skips placeholder, glob, dots, file:line, own id and manual ACs"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that AC string check skips placeholder, glob, dots, file:line, own id and manual ACs. Converted on touch from ARK-305-AC1 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T483`.

## Expected results

- The test passes: AC string check skips placeholder, glob, dots, file:line, own id and manual ACs.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
