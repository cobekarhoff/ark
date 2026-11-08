---
id: ARK-T105
title: ARK-T105 plan check passes a valid 4-repo plan and prints the merge order
level: integration
technique: state transition (invalid to valid), one valid configuration
priority: high
risk: a valid multi-repo plan is refused, or `plan check` prints a merge order that differs from the `repos` graph
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that `ark plan check` passes a valid 4-repo plan with submodule, package, compose and api edges, and prints the merge order with `waits for` for each repo.

## Preconditions

- A fixture project whose workspace holds four repos, and a plan whose `repos` block uses all four kinds (`submodule`, `package`, `compose`, `api`), each edge with evidence and a bump step where the kind is submodule or package, and a `needs` path from each upstream implementer to the downstream step.

## Steps

1. Run `ark plan check <run>`.
2. Reorder the `repos` entries in `plan.yml` (the downstream repo first) and run the check again.

## Expected results

- The exit code shall be 0 and the first line shall be `plan ok: <steps> steps, 4 repos, <n> test cases`.
- The output shall list `Merge order:` with the four repos numbered from 1, each downstream repo with `waits for:` and its upstream repos, as in the mockup.
- When the entries are reordered, the order shall stay the same: it follows the edges, not the list.

## Screenshot checkpoints

none: integration case on command output.
