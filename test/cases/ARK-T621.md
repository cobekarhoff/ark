---
id: ARK-T621
title: "ARK-T621 --merge stays allowed after a merge step finished as failed"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/run.ts merge guard breaks this contract: a failed merge step keeps the conflict"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --merge stays allowed after a merge step finished as failed. Converted on touch from ARK-233-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts merge guard`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T621`.

## Expected results

- The test passes: --merge stays allowed after a merge step finished as failed.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
