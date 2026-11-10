---
id: ARK-T108
title: ARK-T108 a 3-repo hand-off lists the branches in repo order with each pending bump
level: integration
technique: state transition (bump pending to done), boundary on empty repo
priority: medium
risk: "a `merge_requests: none` project hands off branches in an arbitrary order, or hides a bump that is not done, so the human merges a downstream repo before its upstream or ships a stale pin"
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that `ark run close <run> handed_off` and `ark status <run>` list the branches in the `repos` order with the order number, and list each repo with a bump step that is not done as `pending bump`.

## Preconditions

- A fixture project with `merge_requests: none`, 3 repos with commits on the run branch except one, the plan of the mockup, and the run state where `bump-platform` is done and `bump-reports` is not. The `repos` order differs from the order of the steps.

## Steps

1. Run `ark run close <run> handed_off`, then `ark status <run>`.
2. Mark `bump-reports` done and run `ark status <run>` again.
3. Make the last repo have no commits ahead of its base and run `ark status <run>` again while its bump is pending.
4. Use a plan with several repos and no `repos` list.
5. Edit the plan so the `repos` graph has a cycle (core depends on reports) and run `ark status <run>`.

## Expected results

- Both commands shall print the `branch` lines in the order 1, 2, 3 with the order number.
- Under the reports branch, a `pending bump: bump-reports (package repos/shared/clara-core, clara-core>=0.0.6rc1) needs <published version>` line shall print, and nothing shall print for the done `bump-platform`.
- When all bumps are done, no `pending bump` line shall print.
- When a repo has no commits ahead, its `branch` line shall be missing and its pending bump shall still print after the last branch line.
- When the plan has no `repos` list, the line `order: from step needs (no repos list)` shall print once above the branches.
- When the plan's `repos` graph has a dependency cycle, `ark status <run>` shall exit 0 and print the run and a `branch` line for every repo with commits, without an order.

## Screenshot checkpoints

none: integration case on command output.
