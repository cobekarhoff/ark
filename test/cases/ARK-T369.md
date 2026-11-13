---
id: ARK-T369
title: ARK-T369 the run page lists each decision of events.ndjson oldest first with its time, and skips a damaged line
level: e2e
technique: equivalence classes of event type; boundary: one damaged line in the log
priority: medium
risk: "the timeline shows events out of order, drops an event or its time, shows a wrong summary for a type, a non-decision event (`run.started`, `step.started`, `step.finished`) shows as an entry, or a damaged line hides the lines after it"
status: active
changed_by: 2026-11-13-ARK-433-1
---

## Objective

Prove that the run page timeline lists each decision event of `events.ndjson` oldest first with its time and a summary, and skips a damaged line.

Expected: The run page shall list the 8 decision events in the order of the log with their times, and a damaged line shall not stop the list.

## Preconditions

- A closed run whose `events.ndjson` holds run.started, evaluation.recorded, strategy.recorded, gate.answered, plan.checked, step.started, step.finished, test.completed, escalation.requested, merge_request.opened and run.closed at known offsets, and one damaged line.
- The hub runs on the frozen clock.

## Steps

1. Open `run/<run>`.
2. Read the type and time of each timeline entry.
3. Read the summary of each entry type.

## Expected results

- 8 entries, in log order: evaluation.recorded, strategy.recorded, gate.answered, plan.checked, test.completed, escalation.requested, merge_request.opened, run.closed.
- `run.started`, `step.started`, `step.finished` and the damaged line have no entry.
- Each time equals the run start plus the offset of the event.
- Summaries: "strategy gate: S2", "2 cards, recommended S2", "2 steps", "2 risks", the escalation reason, "1 fail" and "2 pass", the merge request link, "handed_off".

## Screenshot checkpoints

none: the case checks text, counts and attributes, not appearance.
