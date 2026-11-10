---
id: ARK-T194
title: ARK-T194 the owner file in the evidence scratch folder is not read as evidence and does not enter the test cache
level: integration
technique: state transition (scratch folder, cache store, cache reuse)
priority: medium
risk: ark-owner.pid inside ark-evidence-* is cpSync'd into the test cache and merged into results/evidence, so a cache hit shows a stray entry, a case folder named ark-owner.pid, or a parse failure in the case-ID merge
status: active
changed_by: 2026-11-10-ARK-404-1
---

## Objective

A reused or merged result is identical with and without the owner file in the scratch folder; the file is not an evidence entry.

## Preconditions

- A fixture run with one fake suite that writes evidence for one case ID.
- `ark test` run twice so the second is `reused` from the cache (see ARK-T163).

## Steps

1. Run `ark test <run>`; list `results/evidence/`.
2. List the cache entry of the suite.
3. Run `ark test <run>` again (cache hit); list `results/evidence/` and read the criterion status.

## Expected results

- `results/evidence/` holds only case-ID folders; no `ark-owner.pid` entry at any level.
- The cache entry holds no `ark-owner.pid`, or `loadCached` ignores it; the reused run gives the same statuses as the first.
- No error from the case-ID merge.

## Screenshot checkpoints

none: no UI.
