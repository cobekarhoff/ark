---
id: ARK-T473
title: "ARK-T473 retro text prints one by auto and one by human escalation line"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: retro text prints one by auto and one by human escalation line"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that retro text prints one by auto and one by human escalation line. Converted on touch from ARK-288-AC7 by the ARK-386 campaign. Production owner: `cli/retro.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T473`.

## Expected results

- The test passes: retro text prints one by auto and one by human escalation line.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
