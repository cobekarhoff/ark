---
id: ARK-T210
title: ARK-T210 `ark run step <run> <step> start` starts the step's worker through Orca and records the dispatch, the terminal and the session, or `unknown` after 60 s
level: integration
technique: state transition (not started to running) with equivalence classes for the session lookup (file shows, file does not show)
priority: high
risk: start launches the worker with the wrong harness, model or worktree; records no terminal or session, so a later restore has nothing; waits a real 60 s in a test or records no `unknown` when no session file shows; the `worker.started` record breaks the derivation of old runs
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that `ark run step <run> <step> start` starts the plan step's worker through Orca in the step's worktree with the harness and model of the plan step, and records the dispatch, the terminal and the session file in the run events, or the session as unknown when no file shows within 60 s.

## Preconditions

- A fake `orca` executable on `PATH` (a script over `$FAKE_ORCA_DIR/state.json` that logs every call to `calls.log`), as `test/run.test.ts` does. No real Orca, no real `ark test`, no `omp`, no test-runner. A `worker-start` call from the fake creates a terminal record and writes nothing else.
- A fake session folder in `ARK_OMP_SESSIONS` (a scratch folder under the host temp folder) that the fake Orca fills on demand with one session file for the worktree cwd.
- A scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree. Every child process the case starts is killed in teardown, and the scratch folders are removed.
- The plan has one implementer step with `harness: omp` and a `model`. The step has never started.
- Case A: the fake Orca writes a session file for the worktree cwd into the fake session folder soon after `worker-start`.
- Case B: the fake Orca writes no session file. The ark clock (`cli/clock.ts`) is the test clock, so 60 s pass without a real sleep.
- An old run folder with a `step.started` and no worker event, for the last step.

## Steps

1. Case A: run `ark run step <run> <step> start`.
2. Read the fake Orca call log: the `worker-start` call, its `--worktree`, `--agent` and `--model` flags, and the `--from` coordinator.
3. Read the run events and `ark status <run>`.
4. Case B: run `ark run step <run> <step> start` on a second step, advance the test clock by 60 s.
5. Read the run events of the second step.
6. Derive the state of the old run (the run with no worker event).

## Expected results

- When the step starts, the system shall call the fake Orca `worker-start` once, with the worktree of the step, the harness and the model of the plan step, and exit 0.
- Case A: the run events shall hold the `step.started` and a worker event with the dispatch id, the terminal handle and the session file path of the fake session folder. `ark status` shall show the step `running`.
- Case B: after 60 s on the test clock the run events shall record the session as `unknown`, the step shall show `running`, and the case shall use no real 60 s wait.
- The old run without a worker event shall still derive its steps without an error.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
