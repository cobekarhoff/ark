---
id: ARK-T26
title: ARK-T26 CLI reference matches the generated output and lists --summary
level: integration
technique: generated-file equality and a repo check run
priority: medium
risk: docs/reference/cli.md is stale and misses the --summary flag, or a repo check (test, typecheck, lint, format:check) fails after the change
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `docs/reference/cli.md` equals what `bun scripts/cli-reference.ts` generates and lists the new flag, and that the repo checks exit 0. Serves ARK-316/AC11.

Expected: When the reference is generated, the system shall list the `--summary` flag.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- `docs/reference/cli.md` as committed.

## Steps

1. Run `bun scripts/cli-reference.ts` into a temporary path (or in place), and compare with the committed `docs/reference/cli.md`.
2. Find the `merge-request open` entry in the file.
3. Run `bun test`.
4. Run `bun run typecheck`.
5. Run `bun run lint`.
6. Run `bun run format:check`.

## Expected results

- The committed file equals the generated output byte for byte.
- The `merge-request open` entry lists `--summary`.
- `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` each exit 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
