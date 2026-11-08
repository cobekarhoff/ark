---
id: ARK-T86
title: ARK-T86 --help lists --project for each run-id command, and docs/reference/cli.md matches the generator
level: integration
technique: help output and generated-file equality
priority: medium
risk: A run-id command loses [--project <name>] in --help, or the CLI reference is stale
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove --help lists --project on each run-id command and the reference equals the generated one. Converted on touch from ARK-209-AC3.

Expected: When help is printed, each run-id command shall list --project.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T86 --help lists --project for each run-id command, and docs/reference/cli.md matches the generator`.

## Expected results

- The test passes: --help lists --project on each run-id command and the reference equals the generated one.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
