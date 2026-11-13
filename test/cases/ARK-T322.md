---
id: ARK-T322
title: "ARK-T322 with 2,000 messages and 20 runs the hub pages keep their p95 and the project conversation answers within 1 s"
level: integration
technique: "boundary values (budget limits at the AC's load) with percentile sampling"
priority: medium
risk: "the 2,000-message conversation read or build blocks the main thread so `/` and `/nope` pass 200 ms p95, or GET /api/conversation takes over 1 s"
status: active
changed_by: 2026-11-12-ARK-344-1
---

## Objective

Prove the AC4 budgets with measured numbers: `/` and `/nope` p95 below 200 ms, and GET /api/conversation below 1 s, with 2,000 messages and 20 runs.

## Preconditions

- A fixture with 20 runs and an inbox of 2,000 messages with bodies of realistic size.
- A hub with a page connected and the inbox already read (follow the `percentile95` precedents in `test/hub.test.ts`).

## Steps

1. Request GET /api/conversation once; time it.
2. Sample `/` and `/nope` repeatedly (the sample size of the existing p95 tests) while GET /api/conversation requests run in the background.
3. Compute the p95 of each page.

## Expected results

- GET /api/conversation answers in less than 1 s.
- The p95 of `/` and of `/nope` is below 200 ms during the background builds.

## Screenshot checkpoints

none: timing case on hub HTTP; no UI surface.
