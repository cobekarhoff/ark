---
id: ARK-T492
title: "ARK-T492 a ticket criterion with no summary row is refused"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a ticket criterion with no summary row is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a ticket criterion with no summary row is refused. Converted on touch from ARK-166-AC2 by the ARK-386 campaign. Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T492`.

## Expected results

- The test passes: a ticket criterion with no summary row is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
