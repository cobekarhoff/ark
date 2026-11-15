---
id: ARK-T441
title: "ARK-T441 a step start before plan approval is refused, names the event, logs nothing"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a step start before plan approval is refused, names the event, logs nothing"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a step start before plan approval is refused, names the event, logs nothing. Converted on touch from ARK-152-AC4 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T441`.

## Expected results

- The test passes: a step start before plan approval is refused, names the event, logs nothing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
