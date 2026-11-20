---
id: ARK-T727
title: ARK-T727 a test.completed event before any merge request is open still clears the escalation answer, and the next failed test escalates again
level: integration
technique: state transition (escalation, answer recorded, building, escalation)
priority: medium
risk: "a failed test.completed event before an MR is open does not move the run to escalation, or the recorded answer is not cleared once the implementer round ends, so the next failed test shows building instead of escalation"
status: active
changed_by: "2026-11-20-ARK-600-1"
---

## Objective

Prove that before any merge request is open, a failed `test.completed` event puts the run in the escalation phase, that `ark gate record escalation one_more_round` lets one implementer round start and finish, and that a second failed event escalates again. The case converts the legacy test ARK-287-AC1 ("before any MR is open a test.completed event still clears the escalation answer") of test/post-mr.test.ts; its title carries this case id after the conversion, and it gets its own `{ timeout }` of at least 30 s because it builds its run through `openRun(` (ARK-600).

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- A building run with no merge request and a round budget of 1.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Append a failed `test.completed` event, then run `ark status`.
3. Run `ark gate record escalation one_more_round`, then `ark run step <run> implementer start` and `finish`, then `ark status`.
4. Append a second failed `test.completed` event, then run `ark status`.

## Expected results

- Step 2: `ark status` prints `phase: escalation`.
- Step 3: the gate record, the start and the finish all exit 0; `ark status` prints `phase: building`.
- Step 4: `ark status` prints `phase: escalation` again.

## Screenshot checkpoints

None. The surface is CLI output and run events; no screenshot applies.
