---
id: ARK-T509
title: "ARK-T509 a bug run's first validator must serve a manual AC too"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a bug run's first validator must serve a manual AC too"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a bug run's first validator must serve a manual AC too. Converted on touch from ARK-302-AC5 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T509`.

## Expected results

- The test passes: a bug run's first validator must serve a manual AC too.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
