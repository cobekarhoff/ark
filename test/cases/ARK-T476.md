---
id: ARK-T476
title: "ARK-T476 close handed_off refuses missing and failing ACs, keeps the worktree"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: close handed_off refuses missing and failing ACs, keeps the worktree"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that close handed_off refuses missing and failing ACs, keeps the worktree. Converted on touch from ARK-304-AC1 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T476`.

## Expected results

- The test passes: close handed_off refuses missing and failing ACs, keeps the worktree.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
