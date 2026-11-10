---
id: ARK-T176
title: ARK-T176 an escalation wait starts at the last step or test event before the escalation, whatever the step outcome
level: integration
technique: real-data scenario (run 2026-11-05-ARK-310-1) plus boundary and equivalence variants of the start event
priority: high
risk: the escalation wait starts only at a failed step, so a review step that succeeded and an answer less than 1 s after the request count 0.002 s instead of 353 minutes
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that `ark retro <run>`, reading a real `events.ndjson`, takes the escalation start is the last `step.finished` or `test.completed` before the first `escalation.requested` or escalation `gate.answered` of that escalation, whatever the step's outcome, and that `metrics.json` records 353 minutes of waiting on you for the shape of run 2026-11-05-ARK-310-1.

## Preconditions

- A temp `ARK_HOME` with a project and one closed run folder for each fixture below, each with a real `events.ndjson`. The real `ark retro` process reads it. No mocks.
- Base fixture with the ARK-310 timestamps: `step.finished` `gaps-review` outcome `succeeded` at 2026-11-06T00:21:43.929Z, no event for 353 minutes, `escalation.requested` at 06:15:04.056Z, escalation `gate.answered` at 06:15:04.083Z, then `run.closed` shortly after. An earlier step finished before `gaps-review`.
- Variants: (a) the same with the `gaps-review` outcome `failed`; (b) the last event before the request is a `test.completed` at 00:30:00.000Z after the `step.finished`; (c) only `gate.answered` (escalation), no `escalation.requested`; (d) a second escalation later in the run, after another `step.finished`; (e) an `escalation.requested` with no step or test event before it.

## Steps

1. Run `ark retro <run>` on the base fixture run; read the exit code.
2. Read `time.waiting_on_you_seconds` (final name per the plan) in its `metrics.json`.
3. Repeat on a run for each variant and read the same field.

## Expected results

- Base fixture: exit 0; the escalation wait starts at 00:21:43.929Z and ends at 06:15:04.083Z; waiting on you is 353 minutes (353 min 20 s, not 0.002 s).
- (a) Same start and same wait as the base fixture: the outcome does not matter.
- (b) The start is the `test.completed` at 00:30:00.000Z, the last event before the request; the wait is 345 min 4 s.
- (c) The `gate.answered` event alone sets the end and the same start rule applies.
- (d) Each escalation starts at its own last step or test event; the first one's wait does not extend into the second.
- (e) With no earlier step or test event the wait starts at the request (and is the request-to-answer time), and no error is thrown.
- A gate other than an escalation (criteria, plan, strategy, manual) keeps its old start.

## Screenshot checkpoints

none: CLI process and a JSON file; no UI.
