---
id: ARK-T415
title: "ARK-T415 evaluation record refuses a missing file or missing section and records nothing"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "a partial evaluation recorded"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that evaluation record refuses a missing file or missing section and records nothing. Converted on touch from ARK-170-AC1 by the ARK-386 campaign. Production owner: `cli/evaluation.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/evaluation.test.ts` whose title starts with `ARK-T415`.

## Expected results

- The test passes: evaluation record refuses a missing file or missing section and records nothing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
