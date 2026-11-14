---
id: ARK-T604
title: "ARK-T604 a repo with no base still starts from the clone HEAD"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts repoBase, resolveBase breaks this contract: base is looked up per repo"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a repo with no base still starts from the clone HEAD. Converted on touch from ARK-296-AC2 by the ARK-386 campaign. Production owner: `cli/worktree.ts repoBase, resolveBase`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T604`.

## Expected results

- The test passes: a repo with no base still starts from the clone HEAD.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
