---
id: ARK-T220
title: "ARK-T220 a spent budget with gates.escalation auto records the answer by auto before step.started and starts the step"
level: integration
technique: "decision table (spent budget, gates.escalation auto)"
priority: medium
risk: "The auto answer is recorded after the start, or not recorded, or the start leaves no worker record"
status: active
changed_by: "2026-11-10-ARK-359-1"
---

## Objective

Prove that a start with a spent budget records the escalation answer by auto first, then the start and its worker. The case converts the legacy test ARK-288-AC1 of test/gates.test.ts: since ARK-359 a start of a step in plan.yml calls Orca, so the test runs against a fake `orca` on PATH and its title carries this case id.

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- `gates.escalation: auto`, a building run whose round budget is spent.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run the `ark` commands the objective names and read the exit codes, the output and the run events.

## Expected results

- The events added by the start are `gate.answered` (escalation, one_more_round, by auto), `step.started`, `worker.started`, in that order; the step is running and the output says `escalation one_more_round by auto (1 of 2)`.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
