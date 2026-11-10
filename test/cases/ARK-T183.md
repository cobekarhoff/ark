---
id: ARK-T183
title: "ARK-T183 ark retro starts the criteria wait at the evaluation blocker event and attributes pre-evaluation usage"
level: integration
technique: "state transition (blocker then criteria answer) plus cost attribution"
priority: medium
risk: "the criteria wait starts at run start instead of the blocker event, or the evaluator's session cost before evaluation.recorded is lost"
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that `ark retro` counts a criteria wait from `evaluation.recorded` with blockers to the criteria answer, and attributes the evaluator session usage to the evaluator role. Converted on touch from ARK-170-AC6.

## Preconditions

- Temp `ARK_HOME`, a closed run with a real `events.ndjson`: `run.started` 14:20:00, `evaluation.recorded` with a blocker 14:21:00, criteria `gate.answered` 14:21:30, `run.closed` 14:22:00.
- One OMP session file for the evaluator (cwd in the run workspace) with one message costing 0.003 USD at 14:20:30.

## Steps

1. Run `ark retro <run>` on the run and read its exit code.
2. Read the `time` block of `metrics.json`.

## Expected results

- Exit 0. `cost.by_role.evaluator.usd` is 0.003.
- `time.waiting_on_you_seconds` is 30 (14:21:00 to 14:21:30), not 90 from run start.

## Screenshot checkpoints

none: CLI process and a JSON file; no UI.
