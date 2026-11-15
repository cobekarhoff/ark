---
id: ARK-T463
title: "ARK-T463 --not-started is a usage error without --failed, with start, with --merge"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: --not-started is a usage error without --failed, with start, with --merge"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --not-started is a usage error without --failed, with start, with --merge. Converted on touch from ARK-282-AC2 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T463`.

## Expected results

- The test passes: --not-started is a usage error without --failed, with start, with --merge.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
