---
id: ARK-T418
title: "ARK-T418 plan.md lists the risks of the latest evaluation only"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "stale risks shown at the plan gate"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan.md lists the risks of the latest evaluation only. Converted on touch from ARK-170-AC5 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/evaluation.test.ts` whose title starts with `ARK-T418`.

## Expected results

- The test passes: plan.md lists the risks of the latest evaluation only.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
