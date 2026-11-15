---
id: ARK-T591
title: "ARK-T591 create that names the dirty root exits 0 without --allow-dirty and warns once on stderr, never on stdout, with no earlier anchor"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts checkClean (root skipped) breaks this contract: create never refuses a dirty root, warns on stderr"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that create that names the dirty root exits 0 without --allow-dirty and warns once on stderr, never on stdout, with no earlier anchor. Converted on touch from ARK-297-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts checkClean (root skipped)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T591`.

## Expected results

- The test passes: create that names the dirty root exits 0 without --allow-dirty and warns once on stderr, never on stdout, with no earlier anchor.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
