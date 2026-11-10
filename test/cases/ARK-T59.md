---
id: ARK-T59
title: ARK-T59 two ark test processes of two runs never run their suites at the same time
level: integration
technique: state transition (free, held, released), plus signal and failure exits
priority: high
risk: two `ark test` runs on one host run their suites together, so the load average rises and timing-sensitive tests fail at random; or the lock stays after a failed suite, or after SIGINT or SIGTERM sent to the detached runner, and blocks every later run until the stale-pid check clears it
status: active
changed_by: 2026-11-09-ARK-366-1
---

## Objective

Prove that `ark test` takes one host-wide lock under `$ARK_HOME`, held by its detached runner, before the first suite, makes a second `ark test` of another run wait with one message, and releases the lock on every runner exit. Serves ARK-343/AC1 and ARK-366/AC1. A signal to the caller no longer stops the suites (ARK-T161 owns that).

Expected: While one runner holds the host lock, the system shall make a second `ark test` of another run print `waiting for ark test of <run> (pid <pid>)` once and start its suites only after the runner has exited; the system shall release the lock when the runner ends by pass, suite failure, SIGINT or SIGTERM.

## Preconditions

- A temporary `ARK_HOME` with two different fixture projects, run A in project 1 and run B in project 2 (a per-project lock would let them overlap), in the style of `test/evidence-test-run.test.ts`.
- Each run's suite command is a script that appends `start <run> <ms>` to a shared log, sleeps about 1 s, then appends `end <run> <ms>`. A variant script exits 1 after the sleep.

## Steps

1. Start `ark test A` as a child process. Wait until the log holds `start A`.
2. Start `ark test B` as a child process. Collect its stdout. Wait for both to exit.
3. Read the log and the stdout of B. Check that `$ARK_HOME` holds no lock after both exit.
4. Failing suite: run `ark test A` with the failing script to the end. Straight after A exits, before starting B, check that `$ARK_HOME` holds no lock. Then run `ark test B` and collect its stdout.
5. Signals to the runner, for SIGINT and again for SIGTERM: start `ark test A` with the sleeping script, wait for `start A`, read the runner pid from the lock holder (not the caller pid) and send the signal to that pid, wait for the runner to exit. Straight after the runner exits, check that `$ARK_HOME` holds no lock. Then run `ark test B` and collect its stdout.

## Expected results

- Step 3: the span `start A`..`end A` and the span `start B`..`end B` do not overlap; `end A` comes before `start B`. B's stdout holds `waiting for ark test of A (pid <pid of A>)` exactly once. The two runs are in different projects, so overlap is prevented only by a host-wide lock. No lock remains.
- Step 4: no lock exists right after A exits; B starts its suites with no `waiting for` line and no `took over a stale` line.
- Step 5: for each signal, no lock exists right after the runner exits, and B starts its suites with no `waiting for` line and no `took over a stale` line, which proves the runner released the lock itself instead of leaving it for the stale-pid check.

## Screenshot checkpoints

None, CLI output.
