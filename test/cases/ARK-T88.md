---
id: ARK-T88
title: ARK-T88 ark run step --help names --not-started and not_started, and docs/reference/cli.md matches the generator
level: integration
technique: help output and generated-file equality
priority: medium
risk: Help of ark run step drops --not-started, or the reference is stale
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove `ark run step --help` names --not-started and not_started and the reference equals the generated one. Converted on touch from ARK-282-AC6.

Expected: When help is printed, ark run step shall name --not-started.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T88 ark run step --help names --not-started and not_started, and docs/reference/cli.md matches the generator`.

## Expected results

- The test passes: `ark run step --help` names --not-started and not_started and the reference equals the generated one.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
