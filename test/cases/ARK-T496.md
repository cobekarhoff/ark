---
id: ARK-T496
title: "ARK-T496 plan.md has summary, change table and an inline Mermaid block, no plan.mmd, and a recheck rewrites it byte for byte"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: plan.md has summary, change table and an inline Mermaid block, no plan.mmd, and a recheck rewrites it byte for byte"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan.md has summary, change table and an inline Mermaid block, no plan.mmd, and a recheck rewrites it byte for byte. Converted on touch from ARK-166-AC1 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T496`.

## Expected results

- The test passes: plan.md has summary, change table and an inline Mermaid block, no plan.mmd, and a recheck rewrites it byte for byte.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
