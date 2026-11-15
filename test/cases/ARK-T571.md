---
id: ARK-T571
title: "ARK-T571 a meta-repo run mirrors the workspace: named repo is a worktree, everything else a symlink"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeCreate, linkUntouched breaks this contract: mirror layout of a meta-repo: named repo worktree, root entries and other repos linked, `.DS_Store` skipped, `worktree.created` shape"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a meta-repo run mirrors the workspace: named repo is a worktree, everything else a symlink. Converted on touch from ARK-154-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeCreate, linkUntouched`. It keeps ARK-154-AC4 too: the campaign removed the copy tests of that criterion (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T571`.

## Expected results

- The test passes: a meta-repo run mirrors the workspace: named repo is a worktree, everything else a symlink.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
