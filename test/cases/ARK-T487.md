---
id: ARK-T487
title: "ARK-T487 a missing or unparsable plan.yml is refused and appends no event"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a missing or unparsable plan.yml is refused and appends no event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a missing or unparsable plan.yml is refused and appends no event. Converted on touch from ARK-153-AC1 by the ARK-386 campaign. Production owner: `cli/plan.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T487`.

## Expected results

- The test passes: a missing or unparsable plan.yml is refused and appends no event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
