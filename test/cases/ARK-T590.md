---
id: ARK-T590
title: "ARK-T590 anchor on a dirty root warns once on stderr, keeps stdout to one path line, and a later create adds no second warning"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts addRepoWorktree (dirtyWarning) breaks this contract: dirty root warns once on stderr; stdout stays one `path:` line"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that anchor on a dirty root warns once on stderr, keeps stdout to one path line, and a later create adds no second warning. Converted on touch from ARK-297-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts addRepoWorktree (dirtyWarning)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T590`.

## Expected results

- The test passes: anchor on a dirty root warns once on stderr, keeps stdout to one path line, and a later create adds no second warning.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
