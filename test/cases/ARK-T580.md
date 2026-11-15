---
id: ARK-T580
title: "ARK-T580 with a root repo and a nested repo the anchor is the mirror root, and create keeps it and makes the nested repo"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeAnchor, addRepoWorktree breaks this contract: anchor of a root with a nested repo is the mirror root; create adds the nested repo"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that with a root repo and a nested repo the anchor is the mirror root, and create keeps it and makes the nested repo. Converted on touch from ARK-276-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeAnchor, addRepoWorktree`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T580`.

## Expected results

- The test passes: with a root repo and a nested repo the anchor is the mirror root, and create keeps it and makes the nested repo.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
