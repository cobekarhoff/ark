---
id: ARK-T90
title: ARK-T90 run close keeps its branch-retention sentence in help, and docs/reference/cli.md equals the generator output
level: integration
technique: help output and generated-file equality
priority: medium
risk: Help of run close loses the handed_off branch-retention sentence, or the reference is stale
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove `ark run close --help` holds the retention sentence and the reference equals the generated one. Converted on touch from ARK-304-AC7.

Expected: When help is printed, run close shall say it keeps each handed_off branch with commits.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T90 run close keeps its branch-retention sentence in help, and docs/reference/cli.md equals the generator output`.

## Expected results

- The test passes: `ark run close --help` holds the retention sentence and the reference equals the generated one.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
