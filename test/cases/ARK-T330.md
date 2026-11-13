---
id: ARK-T330
title: "ARK-T330 a run whose only test failure is red on main opens no escalation gate, spends no round, and opens its merge request"
level: integration
technique: state transition (test.completed passed -> round budget -> merge request open) over the full round budget
priority: high
risk: the red on main file still counts toward the round budget, opens an escalation gate, or makes `merge-request open` refuse with `the last test run did not pass`, so the run waits for a human on a failure it did not cause
status: active
changed_by: 2026-11-13-ARK-428-1
---

## Objective

Prove that a red on main result leaves the budget, the gates and the merge request open untouched.

## Preconditions

- Temporary `ARK_HOME` and git repo with an `origin` remote whose target branch holds an untouched `red.test` that always fails. Run with `round_budget` 2, the fake worker flow and merge request test double of `test/run.test.ts` and `test/merge-request.test.ts`.
- A control run in the same project where an untouched file fails at head and passes on main.

## Steps

1. Start an implementer step, finish it, run `ark test <run>`; repeat until the number of rounds equals the round budget. Read `state.round`, `ark status` and the events after each round.
2. Read the events for `escalation.requested` and open gates.
3. Run `ark merge-request open <run>`.
4. Repeat steps 1 and 3 for the control run.

## Expected results

- Step 1: each `test.completed` has `passed: true`; no new round is needed; `state.round` does not exceed the budget; `ark status` reads `last test: passed`.
- Step 2: no `escalation.requested` event and no open escalation gate.
- Step 3: the merge request opens; it does not print `the last test run did not pass`.
- Step 4: the control run counts every failure: it spends its rounds, requests the escalation at the budget, and `merge-request open` refuses with `the last test run did not pass`.

## Screenshot checkpoints

none: integration case on CLI output, events and state; no UI surface.
