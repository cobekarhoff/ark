---
id: ARK-T222
title: "ARK-T222 every post-MR implementer round needs a fresh escalation answer, including beyond budget"
level: integration
technique: "boundary values (rounds within and beyond the budget)"
priority: medium
risk: "A post-MR implementer start is accepted with no new escalation answer, or an answer is reused for a later round"
status: active
changed_by: "2026-11-10-ARK-359-1"
---

## Objective

Prove that each post-MR implementer start needs a new escalation answer, also beyond the round budget. The case converts the legacy test ARK-208-AC2 of test/post-mr.test.ts: since ARK-359 a start of a step in plan.yml calls Orca, so the test runs against a fake `orca` on PATH and its title carries this case id.

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- A run with an open merge request and a round budget of 1.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run the `ark` commands the objective names and read the exit codes, the output and the run events.

## Expected results

- A start with no fresh answer exits 1 naming `record gate escalation` and appends no event; after `ark gate record escalation one_more_round` the start exits 0 and records `step.started` for that round.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
