---
id: ARK-T546
title: "ARK-T546 a requested escalation is never answered by auto"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a requested escalation is never answered by auto"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a requested escalation is never answered by auto. Converted on touch from ARK-288-AC4 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T546`.

## Expected results

- The test passes: a requested escalation is never answered by auto.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
