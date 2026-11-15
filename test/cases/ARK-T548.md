---
id: ARK-T548
title: "ARK-T548 gates.escalation human or unset refuses a spent budget, no answer"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: gates.escalation human or unset refuses a spent budget, no answer"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that gates.escalation human or unset refuses a spent budget, no answer. Converted on touch from ARK-288-AC5 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T548`.

## Expected results

- The test passes: gates.escalation human or unset refuses a spent budget, no answer.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
