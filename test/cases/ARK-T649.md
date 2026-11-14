---
id: ARK-T649
title: "ARK-T649 a perf run refuses a missing baseline.md and an empty compare.md, names each, opens once both have content"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: a perf run refuses a missing baseline.md and an empty compare.md, names each, opens once both have content"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a perf run refuses a missing baseline.md and an empty compare.md, names each, opens once both have content. Converted on touch from ARK-302-AC6 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T649`.

## Expected results

- The test passes: a perf run refuses a missing baseline.md and an empty compare.md, names each, opens once both have content.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
