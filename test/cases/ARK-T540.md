---
id: ARK-T540
title: "ARK-T540 gates.strategy auto answers with the recommended card by auto"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: gates.strategy auto answers with the recommended card by auto"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that gates.strategy auto answers with the recommended card by auto. Converted on touch from ARK-234-AC3 by the ARK-386 campaign. Production owner: `cli/strategy.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T540`.

## Expected results

- The test passes: gates.strategy auto answers with the recommended card by auto.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
