---
id: ARK-T474
title: "ARK-T474 each kind and a missing kind land in run.started and status; a bad kind exits 1"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: each kind and a missing kind land in run.started and status; a bad kind exits 1"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that each kind and a missing kind land in run.started and status; a bad kind exits 1. Converted on touch from ARK-302-AC4 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T474`.

## Expected results

- The test passes: each kind and a missing kind land in run.started and status; a bad kind exits 1.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
