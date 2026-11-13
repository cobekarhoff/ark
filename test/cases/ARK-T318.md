---
id: ARK-T318
title: ARK-T318 ARK-293-AC5 with session models on the run page, / and /nope answer with a p95 under 200 ms and the page sends no request but the ones ARK-285 allows
level: e2e
technique: request accounting on the run page; p95 of two routes
priority: medium
risk: "the run page sends a request ARK-285 does not allow; `/` or `/nope` takes 200 ms or more at p95"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove the run page with session models sends only the requests ARK-285 allows and that `/` and `/nope` answer under 200 ms at p95. Converted on touch from ARK-293-AC5 (the first-load wait counts the stale chip, ARK-335).

## Preconditions

- A run with agents that have session models, every source answered.

## Steps

1. Open the run page; wait until the stale chip is gone.
2. Assert the requests are the ones ARK-285 allows.
3. Time 50 requests of `/` and of `/nope`; assert the p95 of each is under 200 ms.

## Expected results

- Only the allowed requests.
- p95 of `/` and of `/nope` under 200 ms.

## Screenshot checkpoints

none: the case asserts requests, text and positions.
