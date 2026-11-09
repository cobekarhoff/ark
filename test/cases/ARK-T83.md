---
id: ARK-T83
title: ARK-T83 cli.md equals the generator output
level: integration
technique: generated-file equality
priority: medium
risk: docs/reference/cli.md is stale against scripts/cli-reference.ts
status: retired
retired_reason: duplicate of ARK-302-AC10 in test/project-checks.test.ts, the one owner of the CLI reference equality
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove the committed CLI reference equals the generated one after the manual gate change. Converted on touch from ARK-283-AC5.

Expected: When the reference is generated, the committed file shall be unchanged.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T83 cli.md equals the generator output`.

## Expected results

- The test passes: the committed CLI reference equals the generated one after the manual gate change.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
