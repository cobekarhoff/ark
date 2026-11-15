---
id: ARK-T654
title: "ARK-T654 test_case_source accepts local and the default, refuses other values naming local"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/config.ts breaks this contract: test_case_source accepts local and the default, refuses other values naming local"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that test_case_source accepts local and the default, refuses other values naming local. Converted on touch from ARK-311-AC7 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-case.test.ts` whose title starts with `ARK-T654`.

## Expected results

- The test passes: test_case_source accepts local and the default, refuses other values naming local.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
