---
id: ARK-T564
title: "ARK-T564 a passing check in the repo worktree keeps passed true and prints nothing about it"
level: integration
technique: "equivalence classes (check passes)"
priority: medium
risk: "a configured check runs outside the repo worktree, prints noise or fails a passing run"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a passing check in the repo worktree keeps passed true and prints nothing about it. Converted on touch from ARK-302-AC1 by the ARK-386 campaign. Production owner: `cli/test-run.ts (checks)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T564`.

## Expected results

- The test passes: a passing check in the repo worktree keeps passed true and prints nothing about it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
