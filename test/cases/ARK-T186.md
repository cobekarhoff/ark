---
id: ARK-T186
title: "ARK-T186 ark retro counts design rounds, strategy wait and Designer cost, without an escalation"
level: integration
technique: "real-data scenario (three strategy.recorded events, one answer, one designer step)"
priority: medium
risk: "the strategy wait is not counted as waiting on you, a design round is miscounted, or the Designer cost is lost or counted as an escalation"
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that `ark retro` reports the design rounds, the strategy wait and the Designer cost of a run with a strategy gate. Converted on touch from ARK-173-AC11.

## Preconditions

- Temp `ARK_HOME`, a closed run with a real `events.ndjson`: `run.started` 14:20, `evaluation.recorded` with surface web_ui 14:21, `strategy.recorded` at 14:22, 14:23 and 14:24, strategy `gate.answered` 14:27, designer `step.started` 14:28 and `step.finished` 14:30, `run.closed` 14:31.
- One OMP session file for the designer costing 0.25 USD.

## Steps

1. Run `ark retro <run>` on the run and read its exit code.
2. Read the `time` block of `metrics.json`.

## Expected results

- Exit 0. `design_rounds` is 2.
- `time.waiting_on_you_seconds` is 300 (14:22 to 14:27, from the first strategy record).
- `cost.by_role.designer.usd` is 0.25 and `rework.escalations` is 0.

## Screenshot checkpoints

none: CLI process and a JSON file; no UI.
