---
id: ARK-T325
title: "ARK-T325 a dead process tree of the caller of ark test leaves the runner alive and a new ark test --wait returns its result and exit code"
level: integration
technique: state transition (running, whole caller tree killed, finished) with equivalence classes for the outcome (pass, fail)
priority: high
risk: the runner is still a child of the caller (detached gives it its own process group but its ppid stays the caller), so a kill of the caller and every process below it kills the runner, or leaves runner.json at running with a dead pid, or --wait prints nothing or the wrong exit code
status: active
changed_by: 2026-11-12-ARK-427-1
---

## Objective

Prove that no caller owns the runner: after the caller and every descendant of a helper process die, the runner lives, `results/runner.json` still shows `running`, and a new `ark test <run> --wait` prints the suite result and exits with the runner's exit code.

## Preconditions

- Temporary `ARK_HOME` and git repo (`tempArkHome`, `tempGitRepo`, `writeProject` in `test/helpers.ts`), one run with one suite whose command blocks on a gate file and then exits 0 (a second variant exits 1).
- A helper process (a shell or script) that starts `ark test <run>` as a child and has at least one more child process, so the tree has depth 3 or more (helper, `ark test`, runner, suite).
- The runner is cleaned up with the ARK-419 orphan cleanup (`test/orphan-runners.ts`) so none outlives the test.
- Waits use `runner.json` state, gate files and the clock helpers, never sleeps.

## Steps

1. Start the helper, which starts `ark test <run>`.
2. Wait until `results/runner.json` shows `state: running` with a pid.
3. Snapshot the descendants of the helper by parent pid (the caller `ark test`, the helper's other children, and the runner if it is still a child), then kill the helper and every snapshotted process with SIGKILL. Also kill the process group of the helper.
4. Check that the runner pid is alive, that the suite process is alive, and read `runner.json`.
5. Run `ark test <run> --wait` as a new process, open the gate file, and collect stdout and the exit code.
6. Repeat steps 1-5 with the failing suite.

## Expected results

- Step 2: `runner.json` has `state: running` and a pid that is not the helper pid.
- Step 4: the runner pid and the suite process are alive; `runner.json` still shows `running` with the same pid.
- Step 5: stdout holds the suite result lines, equal to the lines of an uninterrupted `ark test` of the same suite; exit 0.
- Step 6: `--wait` prints the failing suite result and exits 1, the exit code of the runner.
- At the end `runner.json` shows a finished state and no runner process remains.

## Screenshot checkpoints

none: a CLI case with no UI surface.
