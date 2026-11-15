---
id: ARK-T443
title: "ARK-T443 a failed step stays the current step"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "a failed step counted as done"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a failed step stays the current step. Converted on touch from ARK-152-AC5 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T443`.

## Expected results

- The test passes: a failed step stays the current step.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
