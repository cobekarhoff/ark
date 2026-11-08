---
id: ARK-T84
title: ARK-T84 the generated CLI reference equals the file
level: integration
technique: generated-file equality
priority: medium
risk: docs/reference/cli.md is stale against scripts/cli-reference.ts
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove the committed CLI reference equals the generated one. Converted on touch from ARK-295-AC7.

Expected: When the reference is generated, the committed file shall be unchanged.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T84 the generated CLI reference equals the file`.

## Expected results

- The test passes: the committed CLI reference equals the generated one.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
