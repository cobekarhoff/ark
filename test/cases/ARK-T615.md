---
id: ARK-T615
title: "ARK-T615 start --merge after a sync conflict keeps the round although the budget is spent"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/run.ts step start (merge) breaks this contract: a merge start spends no round and is allowed with a spent budget"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that start --merge after a sync conflict keeps the round although the budget is spent. Converted on touch from ARK-211-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts step start (merge)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T615`.

## Expected results

- The test passes: start --merge after a sync conflict keeps the round although the budget is spent.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
