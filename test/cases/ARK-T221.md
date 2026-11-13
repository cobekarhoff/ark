---
id: ARK-T221
title: "ARK-T221 post-MR validator and reviewer steps persist starts, finishes and real suite results"
level: integration
technique: "state transition (merge requests open, validator and reviewer steps)"
priority: medium
risk: "A post-MR validator or reviewer start is not recorded, or its finish or the suite result is lost"
status: active
changed_by: "2026-11-12-ARK-426-1"
---

## Objective

Prove that after the merge requests open, a validator and a reviewer step each persist `step.started`, their worker and `step.finished`, and `ark test` records a real passing result. The case converts the legacy test ARK-208-AC1 of test/post-mr.test.ts: since ARK-359 a start of a step in plan.yml calls Orca, so the test runs against a fake `orca` on PATH and its title carries this case id.

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- A run with an open merge request, validator and reviewer steps in plan.yml.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run the `ark` commands the objective names and read the exit codes, the output and the run events. Before the reviewer finish, make one real commit in the worktree beyond the review start (ARK-426: a reviewer finish with an empty review range is refused).

## Expected results

- For each role the start exits 0 and the event before `worker.started` is `step.started` with the step and role; the finish records `succeeded` (the reviewer finish succeeds only after that commit; validator unchanged); `ark test` records `test.completed` passed and the phase stays merge_requests_open.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
