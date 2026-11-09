---
id: ARK-T113
title: ARK-T113 a newer ark test does not take a free lock while an older live waiter exists
level: integration
technique: state transition (lock free, older live waiter present, then waiter gone) with an equivalence class on the waiter order
priority: high
risk: a newer ark test takes the free lock at once, so a run that waited longer starves behind later runs (ARK-317 waited 3 hours)
status: active
changed_by: 2026-11-08-ARK-396-1
---

## Objective

Prove that a newer `ark test` leaves a free lock alone while a live waiter with an earlier `since` exists, and takes it once that waiter has gone.

## Preconditions

- Temp ARK_HOME with one run (real `ark test` child process, real suite script that logs `start <run>`). Free lock: no `test.lock` directory.
- A live waiter: a spawned `sleep` process (live pid, not the test process). Its file `test-waiters/<pid>.json` holds `{ run, pid, since }` with a `since` earlier than now.

## Steps

1. Start `ark test` for the newer run.
2. Wait until its own waiter file appears in `test-waiters` (registered, polling). Poll for the file, no fixed sleep.
3. Check that for several poll periods (a bounded negative wait of about 500 ms) the lock directory does not exist and the suite log has no `start` line.
4. Kill the spawned `sleep` process and remove its waiter file.
5. Wait for `ark test` to exit.

## Expected results

- While the older live waiter exists, the lock shall stay free and the newer `ark test` shall not start its suites.
- The newer `ark test` shall not wait on its own waiter file: it skips its own pid when it compares.
- After the older waiter has gone, the newer `ark test` shall take the lock, start its suites and exit.
- At the base commit the newer `ark test` takes the free lock at once, so step 3 fails there.

## Screenshot checkpoints

none: integration case on lock files and process output.
