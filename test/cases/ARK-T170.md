---
id: ARK-T170
title: ARK-T170 ark retro gives byte-identical metrics.json with a fixed key order and rounded numbers for the same run data
level: integration
technique: idempotence (same input twice), equivalence class on number formatting
priority: medium
risk: a second `ark retro` of the same run rewrites metrics.json with different bytes (key order, float noise, a clock value), so comparisons and diffs of runs show false changes
status: active
changed_by: 2026-11-09-ARK-366-1
---

## Objective

Prove that `ark retro` on one run twice writes the same `metrics.json` bytes, with the documented key order and numbers rounded to 6 decimals. Converted from the test titled ARK-160-AC1.

Expected: When `ark retro` runs again on the same run data, the system shall write a byte-identical `metrics.json`.

## Preconditions

- A temporary `ARK_HOME` with a fixture run, its `events.ndjson` and fixture agent sessions as in `test/retro.test.ts`.

## Steps

1. Run `ark retro` for the run and read `metrics.json`.
2. Run `ark retro` for the same run again and read `metrics.json`.

## Expected results

- The second file equals the first, byte for byte.
- No number has 7 or more decimals.
- The top-level keys are, in order: run, actual_models, same_vendor_review, cost, time, rework, tests, design_rounds, decisions, human_intervention, gates, escaped_defects, orchestration, comparison.

## Screenshot checkpoints

None, file output.
