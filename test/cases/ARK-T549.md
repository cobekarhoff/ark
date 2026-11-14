---
id: ARK-T549
title: "ARK-T549 gates.escalation human or unset refuses a post-MR repair start and a merge start"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: gates.escalation human or unset refuses a post-MR repair start and a merge start"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that gates.escalation human or unset refuses a post-MR repair start and a merge start. Converted on touch from ARK-288-AC5 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T549`.

## Expected results

- The test passes: gates.escalation human or unset refuses a post-MR repair start and a merge start.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
