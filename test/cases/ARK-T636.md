---
id: ARK-T636
title: "ARK-T636 open names each manual criterion without ok, opens nothing, opens after ok"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: open names each manual criterion without ok, opens nothing, opens after ok"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that open names each manual criterion without ok, opens nothing, opens after ok. Converted on touch from ARK-283-AC4 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T636`.

## Expected results

- The test passes: open names each manual criterion without ok, opens nothing, opens after ok.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
