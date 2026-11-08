---
id: ARK-T94
title: ARK-T94 cli.md matches the generator
level: integration
technique: generated-file equality
priority: medium
risk: docs/reference/cli.md is stale against scripts/cli-reference.ts
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove the committed CLI reference equals the generated one after repos.<repo>.base was added. Converted on touch from ARK-296-AC5.

Expected: When the reference is generated, the committed file shall be unchanged.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T94 cli.md matches the generator`.

## Expected results

- The test passes: the committed CLI reference equals the generated one after repos.<repo>.base was added.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
