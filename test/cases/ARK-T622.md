---
id: ARK-T622
title: "ARK-T622 worktree sync on a closed run exits with a phase error and leaves HEAD unchanged"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeSync (phase check) breaks this contract: sync refused on a closed run before git changes anything"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that worktree sync on a closed run exits with a phase error and leaves HEAD unchanged. Converted on touch from ARK-233-AC3 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeSync (phase check)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T622`.

## Expected results

- The test passes: worktree sync on a closed run exits with a phase error and leaves HEAD unchanged.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
