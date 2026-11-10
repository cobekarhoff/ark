---
id: ARK-T218
title: "ARK-T218 a recheck of an unchanged plan keeps approval and the step starts"
level: integration
technique: "state transition (approved plan rechecked unchanged)"
priority: medium
risk: "A recheck of an unchanged plan clears the approval, so the step start is refused"
status: active
changed_by: "2026-11-10-ARK-359-1"
---

## Objective

Prove that rechecking an unchanged plan keeps the approval, so the step still starts and records its worker. The case converts the legacy test ARK-187-AC1 of test/gate.test.ts: since ARK-359 a start of a step in plan.yml calls Orca, so the test runs against a fake `orca` on PATH and its title carries this case id.

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- An approved run whose plan.yml is unchanged.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run the `ark` commands the objective names and read the exit codes, the output and the run events.

## Expected results

- `ark plan check` of the unchanged plan exits 0; `ark run step <run> build start` then exits 0 and `build` is the current step.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
