---
id: ARK-T436
title: "ARK-T436 repos loads keyed by exact repo path, absent when the key is absent"
level: integration
technique: "boundary values (default and absent input)"
priority: medium
risk: "the contract breaks unnoticed: repos loads keyed by exact repo path, absent when the key is absent"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that repos loads keyed by exact repo path, absent when the key is absent. Converted on touch from ARK-296-AC1 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T436`.

## Expected results

- The test passes: repos loads keyed by exact repo path, absent when the key is absent.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
