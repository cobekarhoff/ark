---
id: ARK-T367
title: ARK-T367 the run page draws one node for each plan step with its role, harness, model, status and cost, and one edge for each dependency
level: e2e
technique: equivalence classes of step status (succeeded, failed, running, pending) plus graph structure
priority: medium
risk: "the run page drops a step node or a dependency edge, shows a wrong status, role, harness or model, or a wrong cost (a step that never ran must show unknown)"
status: active
changed_by: 2026-11-13-ARK-433-1
---

## Objective

Prove that the run page of a run with a 4-step plan draws one `step-node` for each step and one `step-edge` for each `needs` entry.

Expected: The run page shall draw one node for each plan step and one edge for each dependency.

## Preconditions

- A run in phase `building` with steps `write-docs` (done), `build-server` (failed, needs `write-docs`), `build-page` (running, needs `write-docs`) and `review` (never started, needs `build-page`), on 3 harnesses.
- One session message with a cost inside the time window of each started step.
- The hub runs on the frozen clock.

## Steps

1. Open `run/<run>` on the hub.
2. Count the `step-node` elements.
3. For each step assert its name, `role · harness`, model, `data-status`, status label and `step-cost`.
4. Count the `step-edge` elements and read each `data-from`/`data-to`.

## Expected results

- 4 nodes; statuses done, failed, running, pending; costs $0.25, $0.50, $0.75 and unknown for `review`.
- 3 edges: write-docs>build-server, write-docs>build-page, build-page>review; no other.

## Screenshot checkpoints

none: the case checks text, counts and attributes, not appearance.
