---
id: ARK-T579
title: "ARK-T579 without a root repo the anchor is the first repo, and create keeps it and makes the other"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeAnchor (discoverRepos[0]) breaks this contract: anchor picks the first repo of a no-root workspace"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that without a root repo the anchor is the first repo, and create keeps it and makes the other. Converted on touch from ARK-276-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeAnchor (discoverRepos[0])`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T579`.

## Expected results

- The test passes: without a root repo the anchor is the first repo, and create keeps it and makes the other.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
