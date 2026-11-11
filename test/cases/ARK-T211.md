---
id: ARK-T211
title: ARK-T211 `ark run step <run> <step> interrupted` is refused for a live worker terminal and otherwise gives back the round and leaves the dirty file untouched
level: integration
technique: decision table (terminal listed live, listed disconnected, Orca list failing, terminal absent) with state transition (running to interrupted to running)
priority: high
risk: interrupted is accepted while the worker may be alive (two workers in one step), including a listed `disconnected` terminal or an unanswered Orca guessed dead; the round of the interrupted start stays spent so the restart is refused or counted as round 2; the command touches the worktree (reset, stash, clean) and loses the dirty file
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that `interrupted` is refused unless Orca answers and does not list the step's worker terminal (listed in any state, or a failed list, is refused), and then records the step as finished and interrupted, gives the round back, changes no file in the worktree, and lets the step start again.

## Preconditions

- A fake `orca` executable on `PATH` (a script over `$FAKE_ORCA_DIR/state.json` that logs every call to `calls.log`), as `test/run.test.ts` does. No real Orca, no real `ark test`, no `omp`, no test-runner. A `worker-start` call from the fake creates a terminal record and writes nothing else.
- A fake session folder in `ARK_OMP_SESSIONS` (a scratch folder under the host temp folder) that the fake Orca fills on demand with one session file for the worktree cwd.
- A scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree. Every child process the case starts is killed in teardown, and the scratch folders are removed.
- Four independent fixtures, one for each row: each has its own implementer step (or run) in round 1, started through `ark run step <run> <step> start` against the fake Orca, so a worker event with the terminal handle exists and the step is `running`. A refused row leaves its step `running`, but no row reuses another row's step.
- The worktree holds one modified tracked file and one untracked file. Their content and the `git status --porcelain` output are saved before the steps.
- The fake Orca `terminal list` answers per fixture: terminal listed connected, terminal listed `disconnected`, a failing answer (exit 1), and terminal absent from a successful list.

## Steps

1. Fixture A, terminal listed connected: run `ark run step <run> <step> interrupted`. Read the exit code, the message, the events and the step status.
2. Fixture B, terminal listed `disconnected`: run it and read the same.
3. Fixture C, fake Orca failing `terminal list` (exit 1): run it and read the same.
4. Fixture D, terminal absent from a successful list: run it, then read the events, `ark status <run>`, the round of the step, `git status --porcelain` and both files.
5. In fixture D run `ark run step <run> <step> start` again and read the round it takes.

## Expected results

- Fixtures A, B and C: the system shall refuse with a nonzero exit, name the reason (terminal listed with its state, or Orca list failed), append no event, and the step shall stay `running`. A terminal listed in any state, live or `disconnected`, is never treated as dead, and an Orca failure is never treated as dead (unverifiable liveness does not prove exit).
- A running step with no worker event (fixture E): the system shall refuse when the Orca list fails or lists a terminal in the step's worktree, and accept (`step.finished` interrupted) only when Orca answers and lists none.
- Fixture D (Orca answers and the terminal is not listed): the system shall append `step.finished` with the interrupted outcome, exit 0, and `ark status` shall show the step `interrupted`.
- In fixture D the round shall be given back: the next start takes round 1 again, not round 2, and is not refused for the round budget.
- In fixture D `git status --porcelain` and the content of both files shall be byte-identical to the saved copies.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
