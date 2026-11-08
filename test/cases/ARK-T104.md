---
id: ARK-T104
title: ARK-T104 plan check refuses each invalid repos block and names the repo and the edge
level: integration
technique: equivalence classes, one defect per refusal, plus a one-repo boundary
priority: high
risk: a bad repos block passes `ark plan check`, so a run is built and tested before the failure shows, or a refusal omits the repo or edge and the run lead cannot fix it
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that `ark plan check` exits 1 for each of six defects in the `repos` block, names the repo and the edge as `<downstream> -> <upstream> (<kind>)` in each, and prints all problems when several occur.

## Preconditions

- A fixture project whose workspace holds the repos `repos/shared/clara-core`, `repos/platform` and `repos/domains/reports`, with a run folder and a valid `plan.yml` that has a `repos` block. Real `ark plan check`, no mocks.
- The valid plan is the 3-repo Clara shape of the mockup (impl-core, bump-platform, bump-reports, validate, review-core).

## Steps

1. For each defect, copy the valid plan, apply only that defect, and run `ark plan check <run>`:
   a. an edge to `repos/payments`, which is not a repo of the workspace;
   b. a step in `repos/shared/clara-core` while that repo is not in `repos`;
   c. a cycle: `repos/shared/clara-core` depends on `repos/platform` too;
   d. a `bump` that names no step;
   e. a `bump` that names a step of another repo;
   f. a step in a downstream repo with no `needs` path from the upstream implementer.
2. Apply defects a, b and d together and run the check once.
3. Boundary: a plan with steps in one repo and no `repos` list, run the check.
4. Boundary: the upstream repo has only a reviewer step (no implementer), the downstream step has no `needs` path.

## Expected results

- For each of a to f, the exit code shall be 1 and exactly one problem line shall print, naming the repo and the edge (`repos/platform -> repos/payments, api`, and so on); the cycle line shall print the cycle once and name the edge that closes it.
- When defects a, b and d occur together, the output shall say `plan refused: 3 problems` and list all three.
- When the plan has one repo and no `repos` list, the check shall pass and print no order.
- When the upstream repo has no implementer step, the check shall not refuse the downstream step for a missing `needs` path.

## Screenshot checkpoints

none: integration case on command output and exit codes.
