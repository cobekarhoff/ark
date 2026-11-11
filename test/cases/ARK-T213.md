---
id: ARK-T213
title: ARK-T213 `ark retro` counts no round for an interrupted step and `ark status` shows the step as interrupted
level: integration
technique: state transition with boundary values (rounds 1 and 2, with and without an interrupted window)
priority: high
risk: "a consumer of `step.finished` still counts the interrupted finish: retro `rounds`, `merge_steps` or metrics `rework.rounds` report one round too many; `ark status` falls back to `running` or `finished`; the working time of an interrupted window disappears without a decision"
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that `ark retro` counts no round for an interrupted step and `ark status` shows it as `interrupted`.

## Preconditions

- A fake `orca` executable on `PATH` (a script over `$FAKE_ORCA_DIR/state.json` that logs every call to `calls.log`), as `test/run.test.ts` does. No real Orca, no real `ark test`, no `omp`, no test-runner. A `worker-start` call from the fake creates a terminal record and writes nothing else.
- A fake session folder in `ARK_OMP_SESSIONS` (a scratch folder under the host temp folder) that the fake Orca fills on demand with one session file for the worktree cwd.
- A scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree. Every child process the case starts is killed in teardown, and the scratch folders are removed.
- A run folder built with `ark` commands or event fixtures whose derivation is the real code: one implementer step that started (round 1), was marked interrupted, started again (round 1 again) and finished succeeded; a second step that started and is interrupted at the end of the run; a third step with a real round 2 after a failed review.
- No fake Orca call is needed for the retro and status read; the fake Orca stands in for `start` if the case builds the events through the CLI.

## Steps

1. Run `ark status <run>` while the second step is interrupted and read the step list.
2. Run `ark retro <run>` (or its metrics read) and read the rounds and merge steps of each step.
3. Compare the rounds of the first step to the rounds of a run with no interrupt.

## Expected results

- `ark status` shall show the second step as `interrupted`.
- `ark retro` shall count 1 round for the first step (interrupted once, then started and finished), 0 rounds for the second step (started once, interrupted, never restarted), and 2 rounds for the third step (real rework control); the total shall be 3, equal to the same run with no interrupted window.
- The working time of the interrupted window shall follow the decision of the plan (counted or dropped) and the case shall assert it.
- The `interrupted` word shall be in `docs/reference/cli.md` as a step status.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
