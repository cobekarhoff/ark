---
id: ARK-T44
title: ARK-T44 docs/reference/cli.md equals the generated reference
level: integration
technique: generated-file equality
priority: medium
risk: docs/reference/cli.md is stale against what bun scripts/cli-reference.ts generates
status: retired
retired_reason: duplicate of ARK-302-AC10 in test/project-checks.test.ts, the one owner of the CLI reference equality
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove that `docs/reference/cli.md` equals what `bun scripts/cli-reference.ts` generates. Serves ARK-316/AC11.

Expected: When the reference is generated, the system shall produce a file equal to the committed `docs/reference/cli.md`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- `docs/reference/cli.md` as committed.

## Steps

1. Run `bun scripts/cli-reference.ts`, which regenerates `docs/reference/cli.md` in place.
2. Compare the regenerated file with the committed content, then restore the committed content.

## Expected results

- The generator exits 0.
- The regenerated file equals the committed file byte for byte.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
