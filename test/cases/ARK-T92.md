---
id: ARK-T92
title: ARK-T92 mockups remain outside actual worktrees and use one human review loop
level: integration
technique: filesystem boundary
priority: medium
risk: Mockups are copied into a repo worktree
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove a mockup in the run folder is not copied into the worktree by `ark worktree create`. Converted on touch from ARK-173-AC13.

Expected: Mockups shall stay in the run folder and never appear in a repo worktree.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T92 mockups remain outside actual worktrees and use one human review loop`.

## Expected results

- The test passes: a mockup in the run folder is not copied into the worktree by `ark worktree create`.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
