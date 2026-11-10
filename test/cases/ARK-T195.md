---
id: ARK-T195
title: ARK-T195 ark retro reports restarts, crashes, tool errors, context overflows and idle gaps of a run in the orchestration block of metrics.json
level: integration
technique: equivalence classes (fixture sessions with failed calls, a crash, overflows and a gap)
priority: medium
risk: the orchestration block drops a count, names a wrong key, or misses the new tool_error_list key
status: active
changed_by: 2026-11-10-ARK-410-1
---

## Objective

Prove that `ark retro` writes the orchestration block of `metrics.json` with every counter. Converted on touch from the test titled ARK-160-AC6 (the first one, "reports tool errors, context overflows, idle gaps, crashes, restarts and the cost of the run lead"), which gained the key `tool_error_list`.

Expected: When `ark retro` runs on a run with sessions, the system shall write the orchestration block with sessions, restarts, crashes, stalled workers, dead dispatches, tool errors, tool error list, context overflows, idle gaps and the cost of the run lead.

## Preconditions

- A temporary `ARK_HOME` with a fixture run, its `events.ndjson` and the fixture sessions of `test/fixtures/retro/` (omp build and review, claude lead), as in `test/retro.test.ts`.

## Steps

1. Run `ark retro` for the run.
2. Read `orchestration` in `metrics.json`.

## Expected results

- The block equals: 3 sessions, 0 restarts, 1 crash, 0 stalled workers, 0 dead dispatches, 2 tool errors, a `tool_error_list` with one entry (`unknown`, no word, count 2, empty first error, because the fixture failed results name no tool), 3 context overflows, 1 idle gap and the run lead cost.

## Screenshot checkpoints

None, file output.
