---
id: ARK-T470
title: "ARK-T470 an open project and a project with no ark.yml print `merge requests: not opened yet` for a run with no MR"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "an open project, or a project whose ark.yml is missing, prints a bare `merge requests: none` or `(local only)` for a run with no MR, so a run lead reads it as a local-only project and skips `ark merge-request open`"
status: active
changed_by: 2026-11-19-ARK-464-1
---

## Objective

Prove that `ark status <run>` of an open project, and of a project whose ark.yml is missing, prints `merge requests: not opened yet` for a run with no MR, and prints no `(local only)` and no branch line. Converted on touch from ARK-295-AC5 by the ARK-386 campaign; the expected line changed in ARK-464. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T470`.

## Expected results

- The test passes: for an open project and for a project with no ark.yml, the output holds the line `merge requests: not opened yet`, never `(local only)`, and no local branch line.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
