---
id: ARK-T538
title: "ARK-T538 gates.plan auto leaves the gate open while a decision is open"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: gates.plan auto leaves the gate open while a decision is open"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that gates.plan auto leaves the gate open while a decision is open. Converted on touch from ARK-234-AC2 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T538`.

## Expected results

- The test passes: gates.plan auto leaves the gate open while a decision is open.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
