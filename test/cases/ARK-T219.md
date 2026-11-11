---
id: ARK-T219
title: "ARK-T219 gates.plan auto approves a valid plan with no open decision by auto"
level: integration
technique: "state transition (planning to building by auto answer)"
priority: medium
risk: "An auto plan gate records no approval or a human one, so the run never reaches building or the step cannot start"
status: active
changed_by: "2026-11-10-ARK-359-1"
---

## Objective

Prove that `gates.plan: auto` records one plan approval by auto for a valid plan, the run is building, and the first step starts. The case converts the legacy test ARK-234-AC2 of test/gates.test.ts: since ARK-359 a start of a step in plan.yml calls Orca, so the test runs against a fake `orca` on PATH and its title carries this case id.

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- `gates.plan: auto` in ark.yml, a recorded evaluation and a valid plan.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run the `ark` commands the objective names and read the exit codes, the output and the run events.

## Expected results

- One `gate.answered` for the plan with `answer: approve` and `by: auto`; the phase is building; `ark run step <run> build start` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
