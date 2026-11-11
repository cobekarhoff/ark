---
id: ARK-T212
title: ARK-T212 The next start of an interrupted step restores the recorded session with `omp --restore <session>`, else starts a fresh worker briefed to read `git status` and `git diff`
level: integration
technique: decision table (session recorded, none or unknown, harness without restore command, restore fails)
priority: high
risk: the restart ignores the recorded session and loses the worker's context; it runs a restore with the wrong or an unknown session; a failed restore leaves the step running with no worker instead of falling back to a fresh worker; the fresh brief omits the interrupted notice or the `git status`/`git diff` instruction, so a worker redoes or overwrites the work left behind
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that the next start of an interrupted step restores the recorded session with the harness restore command, and starts a fresh worker with an interrupted brief when no session is recorded, the harness has no restore command, or the restore fails.

## Preconditions

- A fake `orca` executable on `PATH` (a script over `$FAKE_ORCA_DIR/state.json` that logs every call to `calls.log`), as `test/run.test.ts` does. No real Orca, no real `ark test`, no `omp`, no test-runner. A `worker-start` call from the fake creates a terminal record and writes nothing else.
- A fake session folder in `ARK_OMP_SESSIONS` (a scratch folder under the host temp folder) that the fake Orca fills on demand with one session file for the worktree cwd.
- A scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree. Every child process the case starts is killed in teardown, and the scratch folders are removed.
- Four interrupted steps in one run, each with a recorded worker event: (a) a session file path, harness omp; (b) session `unknown`; (c) a session path and a harness with no restore command (a fake harness name); (d) a session path, harness omp, but the fake Orca fails the terminal create or the bind for the restore.
- The fake Orca logs `terminal create`/`worker-start --terminal` calls with their `--command` and the spec text.

## Steps

1. For (a): run `ark run step <run> <step> start`. Read the fake Orca calls and the events.
2. For (b), (c) and (d): run `start` on each step. Read the fake Orca calls, the spec the fake received and the events.
3. For (d): read the final state of the step.

## Expected results

- (a) the system shall run `omp --restore <session>` with the recorded path in a terminal of the step's worktree, bound as a supervised Dispatch, and shall make no fresh `worker-start --agent` call. The events shall hold a new worker event for the same step.
- (b), (c) the system shall start a fresh worker whose spec says that an earlier worker was interrupted and that it must read `git status` and `git diff` before it goes on, and shall run no restore command.
- (d) when the restore fails, the system shall fall back to the fresh worker with the same spec text, the step shall show `running` with the new worker, and no terminal of the failed restore shall stay in the fake Orca.
- No case shall start a real omp or a real Orca process.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
