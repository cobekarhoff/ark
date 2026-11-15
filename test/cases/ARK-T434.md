---
id: ARK-T434
title: "ARK-T434 any other merge_requests value is refused, and run start names the rule"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: any other merge_requests value is refused, and run start names the rule"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that any other merge_requests value is refused, and run start names the rule. Converted on touch from ARK-295-AC1 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T434`.

## Expected results

- The test passes: any other merge_requests value is refused, and run start names the rule.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
