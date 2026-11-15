---
id: ARK-T416
title: "ARK-T416 evaluation record needs roles.evaluator"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "a run evaluated with no evaluator configured"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that evaluation record needs roles.evaluator. Converted on touch from ARK-170-AC1 by the ARK-386 campaign. Production owner: `cli/evaluation.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/evaluation.test.ts` whose title starts with `ARK-T416`.

## Expected results

- The test passes: evaluation record needs roles.evaluator.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
