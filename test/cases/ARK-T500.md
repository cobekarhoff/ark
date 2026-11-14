---
id: ARK-T500
title: "ARK-T500 a bare `- ` YAML caller (null) is refused as a blank caller"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a bare `- ` YAML caller (null) is refused as a blank caller"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a bare `- ` YAML caller (null) is refused as a blank caller. Converted on touch from ARK-185-AC2 by the ARK-386 campaign. Production owner: `cli/plan.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T500`.

## Expected results

- The test passes: a bare `- ` YAML caller (null) is refused as a blank caller.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
