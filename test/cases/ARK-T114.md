---
id: ARK-T114
title: ARK-T114 a waiter file of an ended pid blocks nobody
level: integration
technique: equivalence classes (live waiter versus ended-pid waiter) on a free lock
priority: high
risk: a leftover waiter file of a crashed run with an earlier since blocks every later ark test for ever
status: active
changed_by: 2026-11-08-ARK-396-1
---

## Objective

Prove that a waiter file whose pid has ended does not hold back a newer `ark test`, while a live older waiter still does.

## Preconditions

- Temp ARK_HOME with one run and a free lock.
- An ended pid: a spawned process (for example `true`) that has exited. Its file `test-waiters/<pid>.json` holds `{ run, pid, since }` with the earliest `since`.
- A live older waiter: a spawned `sleep` (not the test process) with its own waiter file and a `since` later than the ended file but earlier than now.

## Steps

1. Write the ended-pid waiter file and the live waiter file.
2. Start `ark test` for the newer run. Wait until it registers its own waiter file.
3. Kill the live waiter. Do not delete the ended-pid file.
4. Wait for the newer `ark test` to end.

## Expected results

- While the live waiter lives, the newer `ark test` shall not take the lock: no lock directory, no `start` line, still running.
- After the live waiter is killed, the newer `ark test` shall take the lock and exit 0, with a `start` line in the suite log.
- The output shall name the live waiter's run in a `waiting for` line and shall not name the ended-pid run.
- The newer `ark test` shall leave no lock directory behind.

## Screenshot checkpoints

none: integration case on lock files and process output.
