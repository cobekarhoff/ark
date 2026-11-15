---
id: ARK-T616
title: "ARK-T616 a finished merge step does not raise the round of the next implementer start"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/run.ts, cli/events.ts round derivation breaks this contract: a merge step leaves the next start's round unchanged"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a finished merge step does not raise the round of the next implementer start. Converted on touch from ARK-211-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts, cli/events.ts round derivation`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T616`.

## Expected results

- The test passes: a finished merge step does not raise the round of the next implementer start.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
