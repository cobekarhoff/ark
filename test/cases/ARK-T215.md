---
id: ARK-T215
title: ARK-T215 A refused start and an Orca failure leave no worker and no running step
level: integration
technique: decision table (refusal before Orca, Orca fails, Orca succeeds)
priority: high
risk: the start launches a worker and is then refused (`round budget spent`) so a worker runs with no step; or `step.started` is recorded first and `worker-start` fails, so the step stays `running` with a spent round and no worker
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that `start` checks the transition before it calls Orca, and that when Orca fails after the check, the step ends as not started with its round given back.

## Preconditions

- A fake `orca` executable on `PATH` (a script over `$FAKE_ORCA_DIR/state.json` that logs every call to `calls.log`), as `test/run.test.ts` does. No real Orca, no real `ark test`, no `omp`, no test-runner. A `worker-start` call from the fake creates a terminal record and writes nothing else.
- A fake session folder in `ARK_OMP_SESSIONS` (a scratch folder under the host temp folder) that the fake Orca fills on demand with one session file for the worktree cwd.
- A scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree. Every child process the case starts is killed in teardown, and the scratch folders are removed.
- Case A: a step whose round budget is spent (the real refusal of the transition rule).
- Case B: a step that may start, and a fake Orca whose `worker-start` exits 1.
- Case C: the same step with a working fake Orca (control).

## Steps

1. Case A: run `ark run step <run> <step> start`. Read the exit code, the fake Orca call log and the events.
2. Case B: run it with the failing fake Orca. Read the exit code, the events and `ark status <run>`.
3. Run the start again with the working fake Orca (case C).

## Expected results

- Case A: the system shall refuse with a nonzero exit, make no `worker-start` call, and append no event.
- Case B: the system shall exit nonzero with the Orca error, record the step as finished with `not_started`, show the step as not started (not `running`), and the round shall not be spent.
- Case C: the start shall then succeed with round 1.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
