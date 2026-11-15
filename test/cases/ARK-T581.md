---
id: ARK-T581
title: "ARK-T581 anchor works in awaiting_criteria, awaiting_strategy, planning and building, and is refused in closed like create"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts worktreeAnchor (assertAllowed), cli/transitions.ts breaks this contract: phases that allow `worktree.created`"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that anchor works in awaiting_criteria, awaiting_strategy, planning and building, and is refused in closed like create. Converted on touch from ARK-276-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts worktreeAnchor (assertAllowed), cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/worktree.test.ts` whose title starts with `ARK-T581`.

## Expected results

- The test passes: anchor works in awaiting_criteria, awaiting_strategy, planning and building, and is refused in closed like create.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
