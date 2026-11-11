---
id: ARK-T223
title: "ARK-T223 an escalation answer survives ark test after an MR is open and the next implementer start uses it up"
level: integration
technique: "state transition (answer recorded, test run, start)"
priority: medium
risk: "`ark test` clears the answer after an MR is open, or the next start does not use it up and a second start is accepted"
status: active
changed_by: "2026-11-10-ARK-359-1"
---

## Objective

Prove that an escalation answer stays after `ark test` once a merge request is open, that the next implementer start uses it up, and that the one after is refused. The case converts the legacy test ARK-287-AC1 of test/post-mr.test.ts: since ARK-359 a start of a step in plan.yml calls Orca, so the test runs against a fake `orca` on PATH and its title carries this case id.

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- A run with an open merge request, a recorded escalation answer and a budget spent.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run the `ark` commands the objective names and read the exit codes, the output and the run events.

## Expected results

- The answer count is unchanged after `ark test`; the next start exits 0 and records `step.started` for round 2; a further start exits 1 naming `record gate escalation` with no event added.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
