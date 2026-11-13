---
id: ARK-T317
title: ARK-T317 ARK-309-AC8 a filter change on Home, Runs and Roadmap sends no request, and / and /nope answer with a p95 under 200 ms
level: e2e
technique: request accounting around a filter change; p95 of two routes
priority: medium
risk: "a filter change reads the hub again; `/` or `/nope` takes 200 ms or more at p95"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove a project filter change on Home, Runs and Roadmap sends no request and that `/` and `/nope` answer under 200 ms at p95. Converted on touch from ARK-309-AC8 (the first-load wait counts the stale chip, ARK-335).

## Preconditions

- A hub with two projects, every source answered.

## Steps

1. Open Home; wait until the stale chip is gone.
2. Record requests; change the filter on Home, Runs and Roadmap; assert none was sent.
3. Time 50 requests of `/` and of `/nope`; assert the p95 of each is under 200 ms.

## Expected results

- No request after the first load.
- p95 of `/` and of `/nope` under 200 ms.

## Screenshot checkpoints

none: the case asserts requests, text and positions.
