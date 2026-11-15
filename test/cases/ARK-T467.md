---
id: ARK-T467
title: "ARK-T467 status test head line: none, current, stale"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: status test head line: none, current, stale"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status test head line: none, current, stale. Converted on touch from ARK-287-AC2 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T467`.

## Expected results

- The test passes: status test head line: none, current, stale.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
