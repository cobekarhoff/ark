---
id: ARK-T414
title: "ARK-T414 evaluation record writes blockers and risks from evaluation.md"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "a list item dropped or mis-split"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that evaluation record writes blockers and risks from evaluation.md. Converted on touch from ARK-170-AC1 by the ARK-386 campaign. Production owner: `cli/evaluation.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/evaluation.test.ts` whose title starts with `ARK-T414`.

## Expected results

- The test passes: evaluation record writes blockers and risks from evaluation.md.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
