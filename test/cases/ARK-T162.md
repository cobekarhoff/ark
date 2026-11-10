---
id: ARK-T162
title: "ARK-T162 ark test --stop ends the runner and every process of the suites, including a grandchild, and releases the lock"
level: integration
technique: state transition (running to stopped) with an error-guess for the process-group kill of a grandchild
priority: high
risk: --stop or a SIGTERM to the runner kills only the runner, so a suite hub, browser or grandchild keeps running for hours and the lock stays; or the runner kills with pkill -P and misses the grandchild
status: active
changed_by: 2026-11-09-ARK-366-1
---

## Objective

Prove that `ark test --stop` signals the runner, the runner stops every suite process group, and no process of the suites outlives it.

## Preconditions

- Temporary `ARK_HOME` and git repo, one run, one suite whose command starts a long-lived child (`sleep` in a shell that backgrounds a grandchild) and writes the child and grandchild pids to a file.
- Waits use the pid file and process-exit polling through the clock helpers, never sleeps.

## Steps

1. Start `ark test <run>`; wait until the pid file holds the suite child and grandchild pids. Read the runner pid from `runner.json`.
2. Run `ark test <run> --stop` and collect its exit code and output.
3. Wait for the runner pid to end. Check each recorded pid with `kill -0`.
4. Check the lock under `$ARK_HOME` and `runner.json`.
5. Run `ark test <run> --stop` again with no runner, and run `ark test <run>` once more.
6. Kill the runner with SIGKILL during a second test, then run `ark test <run>`.

## Expected results

- Step 2: exit 0 and a line saying the runner of the run was stopped.
- Step 3: the runner, the suite child and the grandchild are all gone.
- Step 4: no lock file; `runner.json` shows the stopped state, not running.
- Step 5: `--stop` with no runner exits non-zero with a message that no test runs; the next `ark test` starts normally.
- Step 6: the runner crash leaves a dead pid; the next `ark test` detects it as stale, takes the lock and runs (no refusal, no hang).

## Screenshot checkpoints

none: integration case on CLI output, files and processes; no UI surface.
