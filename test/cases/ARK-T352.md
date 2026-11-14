---
id: ARK-T352
title: "ARK-T352 with escalation_rounds 4 and gates.escalation auto, 4 extra rounds are answered by auto and the 5th start is refused"
level: integration
technique: "boundary values (cap-1, cap, cap+1) and state transition"
priority: high
risk: "The cap is still the constant 2, the count line still reads `of 2`, or the start past the cap records an answer instead of waiting for the human"
status: active
changed_by: "2026-11-13-ARK-432-1"
---

## Objective

Prove that `ark run step <run> <step> start` takes the cap from `escalation_rounds` instead of a constant, and asks the human past it.

## Preconditions

- A scratch ARK_HOME and a fake `orca` on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- `ark.yml` with `gates.escalation: auto` and `escalation_rounds: 4`.
- A building run whose round budget is spent; no reviewer findings file exists.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Start an extra round 4 times (finish the step with a failing test between starts); read the output and events after each start.
3. Start a 5th extra round; read the exit code, output and events.

## Expected results

- Starts 1-4: each records `gate.answered` (escalation, one_more_round, by auto) before `step.started`; the output says `(1 of 4)` through `(4 of 4)`.
- Start 5: it is refused with the escalation refusal; no `gate.answered` and no `step.started` is added; the escalation gate waits for the human.

## Screenshot checkpoints

None. The surface is CLI output, config load errors and run events; no screenshot applies.
