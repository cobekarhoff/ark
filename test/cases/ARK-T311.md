---
id: ARK-T311
title: ARK-T311 A gate item's age starts at the event that opened the gate and never moves with later events
level: integration
technique: state transition (gate opened, later events appended, re-escalation) over each gate kind; the opening-event choice by equivalence classes (escalation.requested present, absent with budget spent, strategy/plan/criteria gates)
priority: high
risk: "`Gate.since` falls back to the newest event of the run (`hub/snapshot.ts:418-419`), so an escalation card's age resets on each new event and Home sorts it wrong; a fix for the `escalation.requested` case only leaves the budget-spent escalation and the strategy/plan/criteria gates on the same fallback; `findLast(escalation.requested)` taking an earlier, answered escalation gives a second escalation an old age"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that `Gate.since` of every gate kind is the time of the event that opened it and does not change when later events are appended, and that the Home gate order follows it.

## Preconditions

- `bun test test/hub.test.ts`: snapshot built from a run folder fixture (`test/hub-fixtures.ts`) with events at known times; no browser needed because the age is built in `hub/snapshot.ts`.
- Four fixture runs: A escalation with an `escalation.requested` and 3 later events (`step.started`, `step.finished`, `test.completed`); B escalation with no `escalation.requested`, opened when a failed `test.completed` spent the round budget (`round >= round_budget`), with 3 later events; C a run with an answered earlier escalation (`one_more_round`) and a second escalation after a failed test; D a strategy, a plan and a criteria gate each with later events.

## Steps

1. Build the snapshot for A; read `since` of its gate; append 3 events 10, 20 and 30 minutes later; rebuild and read `since` again.
2. Same for B; assert `since` is the time of the event after which the budget was spent.
3. Build C; assert the second escalation's `since` is not the time of the first (answered) `escalation.requested`.
4. Build D's three gates with later events; assert each `since` is the opening event's time.
5. Put two gate runs in one snapshot, A older than the other by opening time, and add a newer event to A only; assert the gate order does not change.

## Expected results

- The age of a gate item shall start at the event that opened the gate: `escalation.requested` for an escalation, else the `step.finished` or `test.completed` after which the round budget was spent.
- The age shall never fall back to the newest event of the run: `since` is equal before and after the 3 later events, and the gate order is equal.
- A second escalation shall take its own opening event, not the earlier answered one.

## Screenshot checkpoints

none: the proof is a snapshot field and its order, with no rendered output.
