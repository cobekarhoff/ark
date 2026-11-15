---
id: ARK-T623
title: "ARK-T623 sync with only repo B conflicting syncs A and C, exits 1 and names B"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeSync (per-repo loop) breaks this contract: one conflicting repo does not stop the others, and the later clean repo is pushed"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that sync with only repo B conflicting syncs A and C, exits 1 and names B. Converted on touch from ARK-241-AC1 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeSync (per-repo loop)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T623`.

## Expected results

- The test passes: sync with only repo B conflicting syncs A and C, exits 1 and names B.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
