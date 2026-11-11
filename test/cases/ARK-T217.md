---
id: ARK-T217
title: "ARK-T217 plan approve after a valid check starts the first build step"
level: integration
technique: "state transition (plan approved to step running)"
priority: medium
risk: "A step starts before the plan gate is open, or after approval records no worker; the old assertions (refusal naming the plan gate, building phase, current step) regress when start calls Orca"
status: active
changed_by: "2026-11-10-ARK-359-1"
---

## Objective

Prove that a step starts only after plan approval, and that the start now also records its worker. The case converts the legacy test ARK-153-AC6 of test/gate.test.ts: since ARK-359 a start of a step in plan.yml calls Orca, so the test runs against a fake `orca` on PATH and its title carries this case id.

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- Plan.yml with one implementer step, `ark plan check` and `ark gate record plan approve` run before the start.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run the `ark` commands the objective names and read the exit codes, the output and the run events.

## Expected results

- `ark run step <run> build start` before approval exits 1 naming `gate.answered plan approve`; after `ark plan check` and approval the phase is building and the start exits 0 with `build` the current step, with a worker event after `step.started`.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
