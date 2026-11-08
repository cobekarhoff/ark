---
id: ARK-T89
title: ARK-T89 status and merge-request open help describe the test head line and the refusal, and docs/reference/cli.md matches the generator
level: integration
technique: help output and generated-file equality
priority: medium
risk: Help of status or merge-request open loses the test head line or the refusal, or the reference is stale
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove the two help texts describe the test head line and the refusal and the reference equals the generated one. Converted on touch from ARK-287-AC6.

Expected: When help is printed, status shall describe test head and merge-request open shall describe its refusal.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T89 status and merge-request open help describe the test head line and the refusal, and docs/reference/cli.md matches the generator`.

## Expected results

- The test passes: the two help texts describe the test head line and the refusal and the reference equals the generated one.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
