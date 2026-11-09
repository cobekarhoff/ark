---
id: ARK-T161
title: "ARK-T161 a caller killed during a suite leaves the runner running with the lock, and ark test --wait prints the result and exit code of the first call"
level: integration
technique: state transition (running, caller dead, finished) with equivalence classes for the outcome (pass, fail) and a boundary at no runner for the run
priority: high
risk: the caller dies, the suites stop or the lock is dropped and a second ark test starts a second set of suites; or --wait prints a different result or exit code than the first call; or --wait on a stale runner.json (dead pid) hangs
status: active
changed_by: 2026-11-09-ARK-366-1
---

## Objective

Prove that the detached runner, not the caller, holds the host lock from its start to its exit, survives a killed caller, and that `ark test --wait` attaches to it, prints the same lines as the first call would have printed and exits with the same code.

## Preconditions

- Temporary `ARK_HOME` and git repo (`tempArkHome`, `tempGitRepo`, `writeProject` in `test/helpers.ts`), one run with one suite whose command blocks on a gate file and then exits 0 (a second variant exits 1).
- Waits use events or gate files and the clock helpers, never sleeps (`test/timeouts.test.ts`).

## Steps

1. Start `ark test <run>` as a child process. Wait until the suite writes its `started` marker.
2. Read `results/runner.json` and the lock file under `$ARK_HOME`: the runner pid is set and the lock holder is that pid, not the caller pid.
3. Kill the caller with SIGKILL. Check that the runner pid and the suite process are alive and the lock holder is unchanged.
4. Run `ark test <run>` again while the runner lives: it attaches or refuses with a message naming the live runner, and starts no second suite process.
5. Run `ark test <run> --wait`, open the gate file, and collect stdout and the exit code.
6. After the runner exits, check that the lock is released and that `runner.json` shows the finished state.
7. Repeat steps 1-5 with the failing suite: `--wait` exits 1.
8. Set `runner.json` to a dead pid in a running state and run `--wait`; run `--wait` on a run with no `runner.json`.

## Expected results

- Step 2: the lock holder pid equals the runner pid and differs from the caller pid.
- Step 3: the suite finishes and writes its marker once, after the caller died.
- Step 4: exactly one suite process exists.
- Step 5: the `--wait` lines equal the lines of an uninterrupted `ark test` of the same suite; exit 0.
- Step 6: no lock file remains.
- Step 7: the same failure lines and exit 1.
- Step 8: a dead pid is reported as a stale runner and `--wait` returns at once with a non-zero exit; no runner gives a message that no test runs for the run.

## Screenshot checkpoints

none: integration case on CLI output, files and processes; no UI surface.
