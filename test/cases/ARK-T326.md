---
id: ARK-T326
title: "ARK-T326 a dead process tree of a helper that ran ark test and ark test --wait leaves the runner alive, and a new --wait returns the exit code of the runner"
level: integration
technique: state transition (running, waiting caller tree killed, finished) with equivalence classes for the outcome (pass, fail)
priority: high
risk: a killed helper tree with a runner starter and a --wait caller stops the runner or leaves it blocked, or a --wait that was attached never reports and a new --wait returns nothing or a wrong exit code
status: active
changed_by: 2026-11-12-ARK-427-1
---

## Objective

Prove that one helper that starts the runner with `ark test <run>` and also runs `ark test <run> --wait`, with child processes, leaves nothing behind when it is killed: killing the helper and every process below it leaves the runner alive, the runner finishes, and a new `ark test <run> --wait` returns the result and the exit code of the runner.

## Preconditions

- Same fixture as ARK-T325: temporary `ARK_HOME`, git repo, one run with one suite that blocks on a gate file and then exits 0 (a second variant exits 1).
- One helper process with child processes. It runs `ark test <run>` (which starts the runner) and, once the suite started, `ark test <run> --wait`.
- The runner is cleaned up with the ARK-419 orphan cleanup so none outlives the test.

## Steps

1. Start the helper: it runs `ark test <run>` and waits until `results/runner.json` shows `state: running`, then runs `ark test <run> --wait`.
2. Wait until both callers run.
3. Snapshot the descendants of the helper, then kill the helper and every snapshotted process with SIGKILL.
4. Check that the runner pid and the suite process are alive and `runner.json` shows `running`.
5. Run a new `ark test <run> --wait`, open the gate file, and collect stdout and the exit code.
6. Repeat steps 1-5 with the failing suite.

## Expected results

- Step 4: the runner and the suite process are alive, and `runner.json` is unchanged.
- Step 5: the runner finishes; stdout holds the suite result lines; exit 0.
- Step 6: the new `--wait` exits 1, the exit code of the runner.
- At the end `runner.json` shows a finished state and no runner process remains.

## Screenshot checkpoints

none: a CLI case with no UI surface.
