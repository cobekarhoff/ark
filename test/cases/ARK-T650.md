---
id: ARK-T650
title: "ARK-T650 eight concurrent `test-case new` print eight consecutive ids above the highest entry; lock in the git dir"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/test-case.ts breaks this contract: eight concurrent `test-case new` print eight consecutive ids above the highest entry; lock in the git dir"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that eight concurrent `test-case new` print eight consecutive ids above the highest entry; lock in the git dir. Converted on touch from ARK-311-AC6 by the ARK-386 campaign. Production owner: `cli/test-case.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-case.test.ts` whose title starts with `ARK-T650`.

## Expected results

- The test passes: eight concurrent `test-case new` print eight consecutive ids above the highest entry; lock in the git dir.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
