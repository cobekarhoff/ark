---
id: ARK-T644
title: "ARK-T644 path strings: tracked file or folder counts; missing path, untracked path and lone slash are refused"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: path strings: tracked file or folder counts; missing path, untracked path and lone slash are refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that path strings: tracked file or folder counts; missing path, untracked path and lone slash are refused. Converted on touch from ARK-307-AC1 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T644`.

## Expected results

- The test passes: path strings: tracked file or folder counts; missing path, untracked path and lone slash are refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
