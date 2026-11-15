---
id: ARK-T433
title: "ARK-T433 merge_requests loads open, none, and open when absent"
level: integration
technique: "boundary values (default and absent input)"
priority: medium
risk: "the contract breaks unnoticed: merge_requests loads open, none, and open when absent"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that merge_requests loads open, none, and open when absent. Converted on touch from ARK-295-AC1 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T433`.

## Expected results

- The test passes: merge_requests loads open, none, and open when absent.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
